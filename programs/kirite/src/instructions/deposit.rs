use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::KiriteError;
use crate::events::DepositCommitted;
use crate::state::protocol::ProtocolConfig;
use crate::state::shield_pool::ShieldPool;
use crate::utils::crypto::{insert_leaf_light, ELGAMAL_CIPHERTEXT_LEN, MERKLE_TREE_HEIGHT};
use crate::utils::validation::require_supported_mint;
use crate::utils::zk::is_canonical_field_element;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DepositParams {
    /// Poseidon-based leaf commitment computed off-chain by the
    /// depositor. Pre-image — (nullifier_secret, blinding_factor,
    /// amount, leaf_index) — never leaves the depositor's device.
    /// On-chain we only insert the hash into the Merkle tree; if the
    /// commitment is malformed the matching withdraw will simply fail
    /// to produce a valid Groth16 proof and the funds become unspendable.
    pub commitment: [u8; 32],
}

#[derive(Accounts)]
#[instruction(params: DepositParams)]
pub struct Deposit<'info> {
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
        constraint = depositor_token_account.owner == depositor.key(),
    )]
    pub depositor_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[inline(never)]
fn do_merkle_insert(
    commitment: &[u8; 32],
    leaf_index: u32,
    filled_subtrees: &mut [[u8; 32]; MERKLE_TREE_HEIGHT],
) -> Result<[u8; 32]> {
    insert_leaf_light(commitment, leaf_index, filled_subtrees)
}

#[inline(never)]
fn do_token_transfer<'info>(
    token_program: AccountInfo<'info>,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let transfer_ctx = CpiContext::new(
        token_program,
        Transfer {
            from,
            to,
            authority,
        },
    );
    token::transfer(transfer_ctx, amount)
}

pub fn handle_deposit(ctx: Context<Deposit>, params: DepositParams) -> Result<()> {
    let pool = ctx.accounts.shield_pool.load()?;
    let denomination = pool.denomination;
    let leaf_index = pool.next_leaf_index;
    let pool_mint = pool.mint;
    let pool_vault = pool.vault;

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

    require!(
        ctx.accounts.depositor_token_account.mint == pool_mint,
        KiriteError::InvalidAmountProof
    );
    require!(
        ctx.accounts.vault.key() == pool_vault,
        KiriteError::InvalidAmountProof
    );

    drop(pool);

    // Reject the all-zero commitment outright. A zero leaf would collide
    // with the Merkle empty-leaf sentinel and corrupt root computation.
    require!(
        params.commitment.iter().any(|&b| b != 0),
        KiriteError::InvalidAmountProof
    );

    // HIGH-004: reject non-canonical field elements (>= BN254 modulus).
    // The on-chain Poseidon syscall consumes raw bytes; the off-chain
    // prover always reduces mod p. Diverging here would silently lock
    // the depositor's funds inside the vault.
    require!(
        is_canonical_field_element(&params.commitment),
        KiriteError::InvalidAmountProof
    );

    // HIGH-001: enforce mint allowlist on deposit.
    require_supported_mint(&ctx.accounts.protocol_config, &pool_mint)?;

    require!(
        ctx.accounts.depositor_token_account.amount >= denomination,
        KiriteError::InsufficientEncryptedBalance
    );

    do_token_transfer(
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.depositor_token_account.to_account_info(),
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.depositor.to_account_info(),
        denomination,
    )?;

    let mut pool_mut = ctx.accounts.shield_pool.load_mut()?;
    let new_root = do_merkle_insert(
        &params.commitment,
        leaf_index,
        &mut pool_mut.filled_subtrees,
    )?;

    pool_mut.push_root(new_root);
    pool_mut.next_leaf_index = leaf_index
        .checked_add(1)
        .ok_or(KiriteError::PoolCapacityExceeded)?;
    pool_mut.total_deposits = pool_mut.total_deposits.saturating_add(1);
    pool_mut.last_deposit_at = Clock::get()?.unix_timestamp;
    drop(pool_mut);

    emit!(DepositCommitted {
        pool: ctx.accounts.shield_pool.key(),
        depositor: ctx.accounts.depositor.key(),
        commitment_hash: params.commitment,
        encrypted_amount: [0u8; ELGAMAL_CIPHERTEXT_LEN],
        leaf_index,
        timestamp: Clock::get()?.unix_timestamp,
    });

    msg!("KIRITE: deposit committed | leaf={}", leaf_index);

    Ok(())
}
