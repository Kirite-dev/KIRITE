use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Token, TokenAccount, Transfer};

use crate::errors::KiriteError;
use crate::events::WithdrawalExecuted;
use crate::state::protocol::ProtocolConfig;
use crate::state::shield_pool::{NullifierSet, PoolEntry, ShieldPool};
use crate::utils::crypto::{
    compute_commitment, compute_nullifier_hash, verify_merkle_proof, MERKLE_TREE_HEIGHT,
};
use crate::utils::math::{calculate_net_amount, split_fee};
use crate::utils::validation::{is_timelock_expired, require_nonzero_bytes};

/// Parameters for withdrawing from a shield pool.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct WithdrawParams {
    /// The nullifier secret (reveals the deposit without linking to depositor).
    pub nullifier_secret: [u8; 32],

    /// Blinding factor used in the original commitment.
    pub blinding_factor: [u8; 32],

    /// Leaf index of the deposit in the Merkle tree.
    pub leaf_index: u32,

    /// Merkle proof — path from leaf to root (20 sibling hashes).
    pub merkle_proof: [[u8; 32]; MERKLE_TREE_HEIGHT],

    /// The Merkle root the proof was computed against.
    /// Must be a known root (current or recent historical).
    pub proof_root: [u8; 32],

    /// Range proof that the withdrawal amount is valid.
    pub range_proof: [u8; 128],
}

#[derive(Accounts)]
#[instruction(params: WithdrawParams)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub shield_pool: AccountLoader<'info, ShieldPool>,

    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        constraint = !protocol_config.is_paused @ KiriteError::ProtocolPaused,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [b"nullifier_set", shield_pool.key().as_ref()],
        bump = nullifier_set.bump,
    )]
    pub nullifier_set: Account<'info, NullifierSet>,

    /// The deposit entry for verification.
    #[account(
        mut,
        constraint = !pool_entry.is_withdrawn @ KiriteError::DepositAlreadyWithdrawn,
    )]
    pub pool_entry: Account<'info, PoolEntry>,

    /// The pool's token vault.
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    /// Vault authority PDA that signs token transfers out of the vault.
    /// CHECK: Derived from pool seeds.
    #[account(
        seeds = [b"vault_authority", shield_pool.key().as_ref()],
        bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// Recipient's token account — can be anyone, breaking the link
    /// between depositor and recipient.
    #[account(mut)]
    pub recipient_token_account: Account<'info, TokenAccount>,

    /// Treasury token account for fee collection.
    #[account(mut)]
    pub treasury_token_account: Account<'info, TokenAccount>,

    /// The token mint (needed for burn CPI).
    #[account(mut)]
    pub mint: Account<'info, anchor_spl::token::Mint>,

    /// The withdrawer who submits the proof (pays gas, receives nothing).
    /// This is intentionally separated from the recipient for privacy.
    #[account(mut)]
    pub relayer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_withdraw(ctx: Context<Withdraw>, params: WithdrawParams) -> Result<()> {
    let pool = ctx.accounts.shield_pool.load()?;
    let denomination = pool.denomination;
    let pool_mint = pool.mint;
    let pool_vault = pool.vault;
    let timelock_seconds = pool.timelock_seconds;
    let clock = Clock::get()?;

    // Validate seed derivation
    let (expected_pool, _) = Pubkey::find_program_address(
        &[
            b"shield_pool",
            pool_mint.as_ref(),
            &denomination.to_le_bytes(),
        ],
        ctx.program_id,
    );
    require!(
        ctx.accounts.shield_pool.key() == expected_pool,
        KiriteError::InvalidAmountProof
    );

    // Validate pool is not frozen
    require!(!pool.frozen(), KiriteError::PoolFrozen);

    // Validate vault, recipient mint, treasury mint, and mint key
    require!(
        ctx.accounts.vault.key() == pool_vault,
        KiriteError::InvalidAmountProof
    );
    require!(
        ctx.accounts.recipient_token_account.mint == pool_mint,
        KiriteError::InvalidAmountProof
    );
    require!(
        ctx.accounts.treasury_token_account.mint == pool_mint,
        KiriteError::InvalidAmountProof
    );
    require!(
        ctx.accounts.mint.key() == pool_mint,
        KiriteError::InvalidAmountProof
    );

    // Validate pool_entry PDA
    let commitment_for_pda = compute_commitment(
        &params.nullifier_secret,
        denomination,
        &params.blinding_factor,
        params.leaf_index,
    );
    let (expected_entry, _) = Pubkey::find_program_address(
        &[
            b"pool_entry",
            ctx.accounts.shield_pool.key().as_ref(),
            &commitment_for_pda,
        ],
        ctx.program_id,
    );
    require!(
        ctx.accounts.pool_entry.key() == expected_entry,
        KiriteError::InvalidAmountProof
    );

    // --- 1. Validate nullifier secret ---
    require_nonzero_bytes(&params.nullifier_secret, KiriteError::InvalidAmountProof)?;
    require_nonzero_bytes(&params.blinding_factor, KiriteError::InvalidAmountProof)?;

    // --- 2. Check timelock ---
    let deposit_time = ctx.accounts.pool_entry.deposited_at;
    require!(
        is_timelock_expired(deposit_time, timelock_seconds, clock.unix_timestamp),
        KiriteError::DepositTimelocked
    );

    // --- 3. Verify the Merkle root is known ---
    require!(
        pool.is_known_root(&params.proof_root),
        KiriteError::InvalidMerkleProof
    );

    // --- 4. Recompute commitment and verify Merkle proof ---
    let commitment = compute_commitment(
        &params.nullifier_secret,
        denomination,
        &params.blinding_factor,
        params.leaf_index,
    );

    require!(
        verify_merkle_proof(
            &commitment,
            &params.merkle_proof,
            params.leaf_index,
            &params.proof_root,
        ),
        KiriteError::InvalidMerkleProof
    );

    // --- 5. Compute and check nullifier hash ---
    let nullifier_hash = compute_nullifier_hash(&params.nullifier_secret, params.leaf_index);

    let consumed = ctx.accounts.nullifier_set.consume(params.leaf_index);
    require!(consumed, KiriteError::NullifierAlreadyUsed);

    // --- 6. Calculate fees ---
    let fee_bps = ctx.accounts.protocol_config.fee_bps;
    let burn_ratio = ctx.accounts.protocol_config.burn_ratio_bps;
    let (net_amount, fee_amount) = calculate_net_amount(denomination, fee_bps)?;
    let (burn_amount, treasury_amount) = split_fee(fee_amount, burn_ratio)?;

    drop(pool);

    // --- 7. Transfer net amount to recipient ---
    let pool_key = ctx.accounts.shield_pool.key();
    let vault_authority_seeds = &[
        b"vault_authority".as_ref(),
        pool_key.as_ref(),
        &[ctx.bumps.vault_authority],
    ];
    let signer_seeds = &[&vault_authority_seeds[..]];

    // Transfer net to recipient
    let transfer_net_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_net_ctx, net_amount)?;

    // Transfer treasury portion
    if treasury_amount > 0 {
        let transfer_treasury_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.treasury_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_treasury_ctx, treasury_amount)?;
    }

    // Burn the burn portion
    if burn_amount > 0 {
        let burn_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.mint.to_account_info(),
                from: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::burn(burn_ctx, burn_amount)?;
    }

    // --- 8. Update state ---
    let mut pool_mut = ctx.accounts.shield_pool.load_mut()?;
    pool_mut.total_withdrawals = pool_mut.total_withdrawals.saturating_add(1);
    pool_mut.fees_collected = pool_mut.fees_collected.saturating_add(fee_amount);
    drop(pool_mut);

    let entry = &mut ctx.accounts.pool_entry;
    entry.is_withdrawn = true;

    emit!(WithdrawalExecuted {
        pool: ctx.accounts.shield_pool.key(),
        recipient: ctx.accounts.recipient_token_account.key(),
        nullifier_hash,
        fee_amount,
        net_amount,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "KIRITE: withdrawal executed | pool={} leaf={} net={} fee={}",
        ctx.accounts.shield_pool.key(),
        params.leaf_index,
        net_amount,
        fee_amount
    );

    Ok(())
}
// rev7
