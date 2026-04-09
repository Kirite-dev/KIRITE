use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::KiriteError;
use crate::events::DepositCommitted;
use crate::state::protocol::ProtocolConfig;
use crate::state::shield_pool::{PoolEntry, ShieldPool};
use crate::utils::crypto::{
    compute_commitment, insert_leaf_light, ELGAMAL_CIPHERTEXT_LEN, MERKLE_TREE_HEIGHT,
};
use crate::utils::validation::require_nonzero_bytes;

/// Parameters for depositing into a shield pool.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DepositParams {
    pub nullifier_secret: [u8; 32],
    pub blinding_factor: [u8; 32],
    /// Pre-computed commitment hash (verified on-chain).
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

    /// Pool entry PDA seeded by pre-computed commitment hash.
    #[account(
        init,
        payer = depositor,
        space = PoolEntry::SPACE,
        seeds = [
            b"pool_entry",
            shield_pool.key().as_ref(),
            &params.commitment,
        ],
        bump,
    )]
    pub pool_entry: Account<'info, PoolEntry>,

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

/// Merkle tree insertion in a separate stack frame.
#[inline(never)]
fn do_merkle_insert(
    commitment: &[u8; 32],
    leaf_index: u32,
    filled_subtrees: &mut [[u8; 32]; MERKLE_TREE_HEIGHT],
) -> Result<[u8; 32]> {
    insert_leaf_light(commitment, leaf_index, filled_subtrees)
}

/// Token transfer in a separate stack frame.
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

/// Validate and compute commitment in a separate stack frame.
#[inline(never)]
fn verify_commitment(
    nullifier_secret: &[u8; 32],
    denomination: u64,
    blinding_factor: &[u8; 32],
    leaf_index: u32,
    claimed_commitment: &[u8; 32],
) -> Result<()> {
    let expected = compute_commitment(nullifier_secret, denomination, blinding_factor, leaf_index);
    require!(
        expected == *claimed_commitment,
        KiriteError::InvalidAmountProof
    );
    Ok(())
}

pub fn handle_deposit(ctx: Context<Deposit>, params: DepositParams) -> Result<()> {
    // Load pool for reads and validate
    let pool = ctx.accounts.shield_pool.load()?;
    let denomination = pool.denomination;
    let leaf_index = pool.next_leaf_index;
    let pool_mint = pool.mint;
    let pool_vault = pool.vault;

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

    // Validate depositor token account mint and vault
    require!(
        ctx.accounts.depositor_token_account.mint == pool_mint,
        KiriteError::InvalidAmountProof
    );
    require!(
        ctx.accounts.vault.key() == pool_vault,
        KiriteError::InvalidAmountProof
    );

    drop(pool);

    // Validate inputs
    require_nonzero_bytes(&params.nullifier_secret, KiriteError::InvalidAmountProof)?;
    require_nonzero_bytes(&params.blinding_factor, KiriteError::InvalidAmountProof)?;

    require!(
        ctx.accounts.depositor_token_account.amount >= denomination,
        KiriteError::InsufficientEncryptedBalance
    );

    // Verify client-provided commitment matches (separate stack frame)
    verify_commitment(
        &params.nullifier_secret,
        denomination,
        &params.blinding_factor,
        leaf_index,
        &params.commitment,
    )?;

    // Transfer tokens (separate stack frame)
    do_token_transfer(
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.depositor_token_account.to_account_info(),
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.depositor.to_account_info(),
        denomination,
    )?;

    // Insert leaf into Merkle tree (separate stack frame)
    let mut pool_mut = ctx.accounts.shield_pool.load_mut()?;
    let new_root = do_merkle_insert(
        &params.commitment,
        leaf_index,
        &mut pool_mut.filled_subtrees,
    )?;

    // Update pool state
    pool_mut.push_root(new_root);
    pool_mut.next_leaf_index = leaf_index
        .checked_add(1)
        .ok_or(KiriteError::PoolCapacityExceeded)?;
    pool_mut.total_deposits = pool_mut.total_deposits.saturating_add(1);
    drop(pool_mut);

    // Record deposit entry
    let entry = &mut ctx.accounts.pool_entry;
    entry.pool = ctx.accounts.shield_pool.key();
    entry.depositor = ctx.accounts.depositor.key();
    entry.commitment_hash = params.commitment;
    entry.leaf_index = leaf_index;
    entry.deposited_at = Clock::get()?.unix_timestamp;
    entry.is_withdrawn = false;
    entry.bump = ctx.bumps.pool_entry;

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
// rev6
// deposit validation branch
