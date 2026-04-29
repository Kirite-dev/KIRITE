use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Token, TokenAccount, Transfer};

use crate::errors::KiriteError;
use crate::events::WithdrawalExecuted;
use crate::state::protocol::ProtocolConfig;
use crate::state::shield_pool::{NullifierRecord, ShieldPool};
use crate::utils::math::{calculate_net_amount, split_fee};
use crate::utils::validation::require_supported_mint;
use crate::utils::zk::{
    pubkey_to_field, u64_to_field_be, verify_membership_proof, N_PUBLIC_INPUTS, PROOF_LEN,
    PUBLIC_INPUT_LEN,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct WithdrawParams {
    /// Groth16 proof bytes: proof_a (64) || proof_b (128) || proof_c (64).
    pub proof: [u8; PROOF_LEN],
    /// Nullifier hash that the proof publishes. Used as the seed of the
    /// `nullifier_record` PDA — its first-time creation is the
    /// double-spend gate.
    pub nullifier_hash: [u8; 32],
    /// Merkle root the proof commits to. Must equal one of the pool's
    /// known roots (current or recent historical).
    pub proof_root: [u8; 32],
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

    /// Per-nullifier marker. `init` reverts if the PDA already exists,
    /// which means this nullifier_hash has already been spent. The
    /// account stays on chain forever as the proof of consumption.
    #[account(
        init,
        payer = relayer,
        space = NullifierRecord::SPACE,
        seeds = [b"nullifier", shield_pool.key().as_ref(), &params.nullifier_hash],
        bump,
    )]
    pub nullifier_record: Box<Account<'info, NullifierRecord>>,

    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: Derived from pool seeds.
    #[account(
        seeds = [b"vault_authority", shield_pool.key().as_ref()],
        bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub recipient_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub treasury_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub mint: Box<Account<'info, anchor_spl::token::Mint>>,

    /// Relayer pays gas + nullifier rent, receives nothing — separated
    /// from the recipient so the on-chain tx never identifies the actual
    /// withdrawer.
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
    let clock = Clock::get()?;

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

    require!(!pool.frozen(), KiriteError::PoolFrozen);

    // HIGH-001: enforce mint allowlist on withdraw.
    require_supported_mint(&ctx.accounts.protocol_config, &pool_mint)?;

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

    require!(
        pool.is_known_root(&params.proof_root),
        KiriteError::InvalidMerkleProof
    );

    // Build the public-input vector in the order the circuit expects:
    // (root, nullifier_hash, amount, recipient_hash). The recipient_hash
    // binding prevents a malicious watcher from replaying the proof to
    // a different address.
    let recipient_field = pubkey_to_field(&ctx.accounts.recipient_token_account.key());
    let public_inputs: [[u8; PUBLIC_INPUT_LEN]; N_PUBLIC_INPUTS] = [
        params.proof_root,
        params.nullifier_hash,
        u64_to_field_be(denomination),
        recipient_field,
    ];

    verify_membership_proof(&params.proof, &public_inputs)?;

    let fee_bps = ctx.accounts.protocol_config.fee_bps;
    let burn_ratio = ctx.accounts.protocol_config.burn_ratio_bps;
    let (net_amount, fee_amount) = calculate_net_amount(denomination, fee_bps)?;
    let (burn_amount, treasury_amount) = split_fee(fee_amount, burn_ratio)?;

    drop(pool);

    let pool_key = ctx.accounts.shield_pool.key();
    let vault_authority_seeds = &[
        b"vault_authority".as_ref(),
        pool_key.as_ref(),
        &[ctx.bumps.vault_authority],
    ];
    let signer_seeds = &[&vault_authority_seeds[..]];

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

    // WSOL accounts cannot be burned (SPL token program rejects `Burn`
    // on native mints). For SOL-denominated pools we redirect the burn
    // share to the treasury instead so the fee split is still honored.
    let is_native_mint = ctx.accounts.mint.key() == anchor_spl::token::spl_token::native_mint::id();
    if burn_amount > 0 && !is_native_mint {
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
    } else if burn_amount > 0 {
        let redirect_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.treasury_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(redirect_ctx, burn_amount)?;
    }

    let mut pool_mut = ctx.accounts.shield_pool.load_mut()?;
    pool_mut.total_withdrawals = pool_mut.total_withdrawals.saturating_add(1);
    pool_mut.fees_collected = pool_mut.fees_collected.saturating_add(fee_amount);
    drop(pool_mut);

    let record = &mut ctx.accounts.nullifier_record;
    record.pool = ctx.accounts.shield_pool.key();
    record.nullifier_hash = params.nullifier_hash;
    record.consumed_at = clock.unix_timestamp;
    record.bump = ctx.bumps.nullifier_record;

    emit!(WithdrawalExecuted {
        pool: ctx.accounts.shield_pool.key(),
        recipient: ctx.accounts.recipient_token_account.key(),
        nullifier_hash: params.nullifier_hash,
        fee_amount,
        net_amount,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "KIRITE: withdrawal executed | pool={} net={} fee={}",
        ctx.accounts.shield_pool.key(),
        net_amount,
        fee_amount
    );

    Ok(())
}
