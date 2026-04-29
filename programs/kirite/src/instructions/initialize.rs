use anchor_lang::prelude::*;

use crate::errors::KiriteError;
use crate::events::{ProtocolInitialized, ProtocolPaused, ProtocolResumed, ShieldPoolCreated};
use crate::state::protocol::{GovernanceState, ProtocolConfig};
use crate::state::shield_pool::{PoolConfig, ShieldPool};
use crate::utils::crypto::compute_zero_hashes;
use crate::utils::validation::{
    require_authority, require_supported_mint, validate_denomination, validate_fee_bps,
    validate_timelock_duration,
};
use anchor_spl::token::TokenAccount;

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = authority,
        space = ProtocolConfig::SPACE,
        seeds = [b"protocol_config"],
        bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = authority,
        space = GovernanceState::SPACE,
        seeds = [b"governance", protocol_config.key().as_ref()],
        bump,
    )]
    pub governance_state: Account<'info, GovernanceState>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Validated as wallet only.
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_protocol(
    ctx: Context<InitializeProtocol>,
    fee_bps: u16,
    burn_ratio_bps: u16,
) -> Result<()> {
    validate_fee_bps(fee_bps)?;
    validate_fee_bps(burn_ratio_bps)?;

    let clock = Clock::get()?;
    let config = &mut ctx.accounts.protocol_config;

    config.authority = ctx.accounts.authority.key();
    config.pending_authority = Pubkey::default();
    config.fee_bps = fee_bps;
    config.burn_ratio_bps = burn_ratio_bps;
    config.treasury = ctx.accounts.treasury.key();
    config.is_paused = false;
    config.supported_mints = Vec::new();
    config.total_pools = 0;
    config.total_deposits = 0;
    config.total_withdrawals = 0;
    config.total_fees_collected = 0;
    config.total_fees_burned = 0;
    config.initialized_slot = clock.slot;
    config.initialized_at = clock.unix_timestamp;
    config.bump = ctx.bumps.protocol_config;
    config._reserved = [0u8; 8];

    let gov = &mut ctx.accounts.governance_state;
    gov.version = 1;
    gov.required_signers = 1;
    gov.signers = [Pubkey::default(); 7];
    gov.signers[0] = ctx.accounts.authority.key();
    gov.total_proposals = 0;
    gov.total_executed = 0;
    gov.bump = ctx.bumps.governance_state;
    gov._reserved = [0u8; 8];

    emit!(ProtocolInitialized {
        authority: ctx.accounts.authority.key(),
        protocol_config: ctx.accounts.protocol_config.key(),
        fee_basis_points: fee_bps,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(config: PoolConfig)]
pub struct InitializeShieldPool<'info> {
    #[account(
        init,
        payer = operator,
        space = ShieldPool::SPACE,
        seeds = [
            b"shield_pool",
            mint.key().as_ref(),
            &config.denomination.to_le_bytes(),
        ],
        bump,
    )]
    pub shield_pool: AccountLoader<'info, ShieldPool>,

    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        constraint = !protocol_config.is_paused @ KiriteError::ProtocolPaused,
        constraint = protocol_config.authority == operator.key() @ KiriteError::UnauthorizedAuthority,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// CHECK: PDA derived from the shield pool; vault_authority_bump
    /// is persisted on `pool` so withdraw can re-sign without trusting
    /// caller-supplied data.
    #[account(
        seeds = [b"vault_authority", shield_pool.key().as_ref()],
        bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = vault.owner == vault_authority.key() @ KiriteError::UnauthorizedAuthority,
        constraint = vault.mint == mint.key() @ KiriteError::UnsupportedMint,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    pub mint: Account<'info, anchor_spl::token::Mint>,

    #[account(mut)]
    pub operator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_shield_pool(
    ctx: Context<InitializeShieldPool>,
    config: PoolConfig,
) -> Result<()> {
    validate_denomination(config.denomination)?;
    validate_timelock_duration(config.timelock_seconds)?;
    // HIGH-001: enforce mint allowlist at pool creation.
    require_supported_mint(&ctx.accounts.protocol_config, &ctx.accounts.mint.key())?;
    // HIGH-003: pool creation is gated to the protocol authority;
    // also re-asserted via the account constraint above.
    require_authority(&ctx.accounts.protocol_config, &ctx.accounts.operator.key())?;

    let clock = Clock::get()?;
    let zero_hashes = compute_zero_hashes();

    let mut pool = ctx.accounts.shield_pool.load_init()?;
    pool.mint = ctx.accounts.mint.key();
    pool.denomination = config.denomination;
    pool.operator = ctx.accounts.operator.key();
    pool.protocol_config = ctx.accounts.protocol_config.key();
    pool.vault = ctx.accounts.vault.key();

    pool.current_root = zero_hashes[crate::utils::crypto::MERKLE_TREE_HEIGHT];
    pool.historical_roots = [[0u8; 32]; crate::state::shield_pool::MAX_HISTORICAL_ROOTS];
    pool.root_history_index = 0;

    for i in 0..crate::utils::crypto::MERKLE_TREE_HEIGHT {
        pool.filled_subtrees[i] = zero_hashes[i];
    }

    pool.next_leaf_index = 0;
    pool.total_deposits = 0;
    pool.total_withdrawals = 0;
    pool.fees_collected = 0;
    pool.timelock_seconds = config.timelock_seconds;
    pool.is_frozen = 0;
    pool.created_at = clock.unix_timestamp;
    pool.last_deposit_at = 0;
    pool.bump = ctx.bumps.shield_pool;
    // HIGH-002: persist the canonical vault_authority bump at init so
    // withdraw can sign with stable seeds without re-deriving.
    pool.vault_authority_bump = ctx.bumps.vault_authority;

    let protocol = &mut ctx.accounts.protocol_config;
    protocol.total_pools = protocol.total_pools.saturating_add(1);

    emit!(ShieldPoolCreated {
        pool: ctx.accounts.shield_pool.key(),
        mint: ctx.accounts.mint.key(),
        denomination: config.denomination,
        operator: ctx.accounts.operator.key(),
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct PauseProtocol<'info> {
    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        constraint = protocol_config.authority == authority.key() @ KiriteError::UnauthorizedAuthority,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

pub fn handle_pause_protocol(ctx: Context<PauseProtocol>) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    config.is_paused = true;

    let clock = Clock::get()?;
    emit!(ProtocolPaused {
        authority: ctx.accounts.authority.key(),
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

pub fn handle_resume_protocol(ctx: Context<PauseProtocol>) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    config.is_paused = false;

    let clock = Clock::get()?;
    emit!(ProtocolResumed {
        authority: ctx.accounts.authority.key(),
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
// init rev #28
