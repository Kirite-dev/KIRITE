use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Token, TokenAccount};

use crate::errors::KiriteError;
use crate::events::{
    AuthorityTransferred, BurnExecuted, FeeUpdated, MintAdded, MintRemoved, PoolFrozen,
};
use crate::state::protocol::{FeeProposal, GovernanceState, ProtocolConfig};
use crate::state::shield_pool::ShieldPool;
use crate::utils::validation::{
    require_governance_timelock_elapsed, validate_fee_bps, validate_freeze_reason,
    GOVERNANCE_TIMELOCK_SECONDS,
};

#[derive(Accounts)]
pub struct ProposeFeeUpdate<'info> {
    #[account(
        init,
        payer = authority,
        space = FeeProposal::SPACE,
        seeds = [
            b"fee_proposal",
            protocol_config.key().as_ref(),
            &governance_state.total_proposals.to_le_bytes(),
        ],
        bump,
    )]
    pub fee_proposal: Account<'info, FeeProposal>,

    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        constraint = protocol_config.authority == authority.key() @ KiriteError::UnauthorizedAuthority,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [b"governance", protocol_config.key().as_ref()],
        bump = governance_state.bump,
    )]
    pub governance_state: Account<'info, GovernanceState>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_propose_fee_update(
    ctx: Context<ProposeFeeUpdate>,
    new_fee_bps: u16,
    new_burn_ratio_bps: u16,
) -> Result<()> {
    validate_fee_bps(new_fee_bps)?;
    validate_fee_bps(new_burn_ratio_bps)?;

    let clock = Clock::get()?;

    let proposal = &mut ctx.accounts.fee_proposal;
    proposal.proposer = ctx.accounts.authority.key();
    proposal.new_fee_bps = new_fee_bps;
    proposal.new_burn_ratio_bps = new_burn_ratio_bps;
    proposal.proposed_at = clock.unix_timestamp;
    proposal.executable_at = clock.unix_timestamp + GOVERNANCE_TIMELOCK_SECONDS;
    proposal.executed = false;
    proposal.cancelled = false;
    proposal.bump = ctx.bumps.fee_proposal;

    let gov = &mut ctx.accounts.governance_state;
    gov.total_proposals = gov.total_proposals.saturating_add(1);

    msg!(
        "KIRITE: fee proposal created | new_fee={} new_burn_ratio={} executable_at={}",
        new_fee_bps,
        new_burn_ratio_bps,
        proposal.executable_at
    );

    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteFeeUpdate<'info> {
    #[account(
        mut,
        constraint = !fee_proposal.executed @ KiriteError::GovernanceQuorumNotMet,
        constraint = !fee_proposal.cancelled @ KiriteError::GovernanceQuorumNotMet,
    )]
    pub fee_proposal: Account<'info, FeeProposal>,

    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        constraint = protocol_config.authority == authority.key() @ KiriteError::UnauthorizedAuthority,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [b"governance", protocol_config.key().as_ref()],
        bump = governance_state.bump,
    )]
    pub governance_state: Account<'info, GovernanceState>,

    pub authority: Signer<'info>,
}

pub fn handle_execute_fee_update(ctx: Context<ExecuteFeeUpdate>) -> Result<()> {
    let clock = Clock::get()?;
    let proposal = &ctx.accounts.fee_proposal;

    require_governance_timelock_elapsed(proposal.proposed_at, clock.unix_timestamp)?;

    let old_fee_bps = ctx.accounts.protocol_config.fee_bps;

    let config = &mut ctx.accounts.protocol_config;
    config.fee_bps = proposal.new_fee_bps;
    config.burn_ratio_bps = proposal.new_burn_ratio_bps;

    let proposal_mut = &mut ctx.accounts.fee_proposal;
    proposal_mut.executed = true;

    let gov = &mut ctx.accounts.governance_state;
    gov.total_executed = gov.total_executed.saturating_add(1);

    emit!(FeeUpdated {
        authority: ctx.accounts.authority.key(),
        old_fee_bps,
        new_fee_bps: proposal_mut.new_fee_bps,
        effective_at: clock.unix_timestamp,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "KIRITE: fee updated | old={} new={} burn_ratio={}",
        old_fee_bps,
        proposal_mut.new_fee_bps,
        proposal_mut.new_burn_ratio_bps
    );

    Ok(())
}

#[derive(Accounts)]
pub struct CancelFeeProposal<'info> {
    #[account(
        mut,
        constraint = !fee_proposal.executed @ KiriteError::GovernanceQuorumNotMet,
        constraint = !fee_proposal.cancelled @ KiriteError::GovernanceQuorumNotMet,
        constraint = fee_proposal.proposer == authority.key() @ KiriteError::UnauthorizedAuthority,
    )]
    pub fee_proposal: Account<'info, FeeProposal>,

    pub authority: Signer<'info>,
}

pub fn handle_cancel_fee_proposal(ctx: Context<CancelFeeProposal>) -> Result<()> {
    let proposal = &mut ctx.accounts.fee_proposal;
    proposal.cancelled = true;

    msg!(
        "KIRITE: fee proposal cancelled | proposer={}",
        proposal.proposer
    );

    Ok(())
}

#[derive(Accounts)]
pub struct AddSupportedMint<'info> {
    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        constraint = protocol_config.authority == authority.key() @ KiriteError::UnauthorizedAuthority,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub mint: Account<'info, anchor_spl::token::Mint>,

    pub authority: Signer<'info>,
}

pub fn handle_add_supported_mint(ctx: Context<AddSupportedMint>) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    let mint = ctx.accounts.mint.key();

    let added = config.add_supported_mint(mint);
    require!(added, KiriteError::UnsupportedMint);

    let clock = Clock::get()?;
    emit!(MintAdded {
        authority: ctx.accounts.authority.key(),
        mint,
        timestamp: clock.unix_timestamp,
    });

    msg!("KIRITE: mint added | mint={}", mint);

    Ok(())
}

#[derive(Accounts)]
pub struct RemoveSupportedMint<'info> {
    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        constraint = protocol_config.authority == authority.key() @ KiriteError::UnauthorizedAuthority,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub mint: Account<'info, anchor_spl::token::Mint>,

    pub authority: Signer<'info>,
}

pub fn handle_remove_supported_mint(ctx: Context<RemoveSupportedMint>) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    let mint = ctx.accounts.mint.key();

    let removed = config.remove_supported_mint(&mint);
    require!(removed, KiriteError::UnsupportedMint);

    let clock = Clock::get()?;
    emit!(MintRemoved {
        authority: ctx.accounts.authority.key(),
        mint,
        timestamp: clock.unix_timestamp,
    });

    msg!("KIRITE: mint removed | mint={}", mint);

    Ok(())
}

#[derive(Accounts)]
pub struct InitiateAuthorityTransfer<'info> {
    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        constraint = protocol_config.authority == authority.key() @ KiriteError::UnauthorizedAuthority,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// CHECK: Validated as wallet only.
    pub new_authority: UncheckedAccount<'info>,

    pub authority: Signer<'info>,
}

pub fn handle_initiate_authority_transfer(ctx: Context<InitiateAuthorityTransfer>) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    config.pending_authority = ctx.accounts.new_authority.key();

    msg!(
        "KIRITE: authority transfer initiated | from={} to={}",
        ctx.accounts.authority.key(),
        ctx.accounts.new_authority.key()
    );

    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAuthorityTransfer<'info> {
    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        constraint = protocol_config.pending_authority == new_authority.key() @ KiriteError::UnauthorizedAuthority,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub new_authority: Signer<'info>,
}

pub fn handle_accept_authority_transfer(ctx: Context<AcceptAuthorityTransfer>) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    let old = config.authority;
    config.authority = ctx.accounts.new_authority.key();
    config.pending_authority = Pubkey::default();

    let clock = Clock::get()?;
    emit!(AuthorityTransferred {
        old_authority: old,
        new_authority: ctx.accounts.new_authority.key(),
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "KIRITE: authority transferred | old={} new={}",
        old,
        ctx.accounts.new_authority.key()
    );

    Ok(())
}

#[derive(Accounts)]
pub struct FreezePool<'info> {
    #[account(mut)]
    pub shield_pool: AccountLoader<'info, ShieldPool>,

    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        constraint = protocol_config.authority == authority.key() @ KiriteError::UnauthorizedAuthority,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

pub fn handle_freeze_pool(ctx: Context<FreezePool>, reason: String) -> Result<()> {
    validate_freeze_reason(&reason)?;

    {
        let pool = ctx.accounts.shield_pool.load()?;
        let (expected_pool, _) = Pubkey::find_program_address(
            &[
                b"shield_pool",
                pool.mint.as_ref(),
                &pool.denomination.to_le_bytes(),
            ],
            ctx.program_id,
        );
        require!(
            ctx.accounts.shield_pool.key() == expected_pool,
            KiriteError::InvalidAmountProof
        );
    }

    let mut pool = ctx.accounts.shield_pool.load_mut()?;
    pool.is_frozen = 1;
    drop(pool);

    let clock = Clock::get()?;
    emit!(PoolFrozen {
        pool: ctx.accounts.shield_pool.key(),
        authority: ctx.accounts.authority.key(),
        reason: reason.clone(),
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "KIRITE: pool frozen | pool={} reason={}",
        ctx.accounts.shield_pool.key(),
        reason
    );

    Ok(())
}

pub fn handle_unfreeze_pool(ctx: Context<FreezePool>) -> Result<()> {
    {
        let pool = ctx.accounts.shield_pool.load()?;
        let (expected_pool, _) = Pubkey::find_program_address(
            &[
                b"shield_pool",
                pool.mint.as_ref(),
                &pool.denomination.to_le_bytes(),
            ],
            ctx.program_id,
        );
        require!(
            ctx.accounts.shield_pool.key() == expected_pool,
            KiriteError::InvalidAmountProof
        );
    }

    let mut pool = ctx.accounts.shield_pool.load_mut()?;
    pool.is_frozen = 0;
    drop(pool);

    msg!(
        "KIRITE: pool unfrozen | pool={}",
        ctx.accounts.shield_pool.key()
    );

    Ok(())
}

#[derive(Accounts)]
pub struct BurnFees<'info> {
    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        constraint = protocol_config.authority == authority.key() @ KiriteError::UnauthorizedAuthority,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub fee_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub mint: Account<'info, anchor_spl::token::Mint>,

    /// CHECK: Derived from protocol seeds.
    #[account(
        seeds = [b"fee_authority", protocol_config.key().as_ref()],
        bump,
    )]
    pub fee_authority: UncheckedAccount<'info>,

    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_burn_fees(ctx: Context<BurnFees>, amount: u64) -> Result<()> {
    require!(amount > 0, KiriteError::MathOverflow);

    let config_key = ctx.accounts.protocol_config.key();
    let fee_auth_seeds = &[
        b"fee_authority".as_ref(),
        config_key.as_ref(),
        &[ctx.bumps.fee_authority],
    ];
    let signer_seeds = &[&fee_auth_seeds[..]];

    let burn_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Burn {
            mint: ctx.accounts.mint.to_account_info(),
            from: ctx.accounts.fee_token_account.to_account_info(),
            authority: ctx.accounts.fee_authority.to_account_info(),
        },
        signer_seeds,
    );
    token::burn(burn_ctx, amount)?;

    let config = &mut ctx.accounts.protocol_config;
    config.total_fees_burned = config.total_fees_burned.saturating_add(amount);

    let clock = Clock::get()?;
    emit!(BurnExecuted {
        authority: ctx.accounts.authority.key(),
        mint: ctx.accounts.mint.key(),
        amount,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "KIRITE: fees burned | mint={} amount={}",
        ctx.accounts.mint.key(),
        amount
    );

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateGovernanceSigners<'info> {
    #[account(
        mut,
        seeds = [b"governance", protocol_config.key().as_ref()],
        bump = governance_state.bump,
    )]
    pub governance_state: Account<'info, GovernanceState>,

    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        constraint = protocol_config.authority == authority.key() @ KiriteError::UnauthorizedAuthority,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

pub fn handle_update_governance_signers(
    ctx: Context<UpdateGovernanceSigners>,
    signers: Vec<Pubkey>,
    required: u8,
) -> Result<()> {
    require!(signers.len() <= 7, KiriteError::InputTooLong);
    require!(
        required > 0 && required as usize <= signers.len(),
        KiriteError::GovernanceQuorumNotMet
    );

    let gov = &mut ctx.accounts.governance_state;
    gov.signers = [Pubkey::default(); 7];
    for (i, signer) in signers.iter().enumerate() {
        gov.signers[i] = *signer;
    }
    gov.required_signers = required;
    gov.version = gov.version.saturating_add(1);

    msg!(
        "KIRITE: governance signers updated | required={} count={}",
        required,
        signers.len()
    );

    Ok(())
}
// gov rev #29
