use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod utils;

use instructions::create_stealth::*;
use instructions::deposit::*;
use instructions::governance::*;
use instructions::initialize::*;
use instructions::withdraw::*;
use state::shield_pool::PoolConfig;
use state::stealth::{CreateStealthParams, ResolveStealthParams};

declare_id!("FjYwYT9PDcW2UmM2siXpURjSSCDoXTvviqb3V8amzusL");

#[program]
pub mod kirite {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        fee_bps: u16,
        burn_ratio_bps: u16,
    ) -> Result<()> {
        handle_initialize_protocol(ctx, fee_bps, burn_ratio_bps)
    }

    /// Fixed-denomination pool to maximise anonymity set size.
    pub fn initialize_shield_pool(
        ctx: Context<InitializeShieldPool>,
        config: PoolConfig,
    ) -> Result<()> {
        handle_initialize_shield_pool(ctx, config)
    }

    pub fn pause_protocol(ctx: Context<PauseProtocol>) -> Result<()> {
        handle_pause_protocol(ctx)
    }

    pub fn resume_protocol(ctx: Context<PauseProtocol>) -> Result<()> {
        handle_resume_protocol(ctx)
    }

    /// Insert a commitment into the Merkle tree and lock tokens in the vault.
    /// Timelocked — cannot withdraw until `timelock_seconds` elapsed.
    pub fn deposit(ctx: Context<Deposit>, params: DepositParams) -> Result<()> {
        handle_deposit(ctx, params)
    }

    /// Prove nullifier knowledge + Merkle inclusion to withdraw.
    /// Nullifier hash published on-chain prevents double-spend;
    /// depositor-recipient link is broken by design.
    pub fn withdraw(ctx: Context<Withdraw>, params: WithdrawParams) -> Result<()> {
        handle_withdraw(ctx, params)
    }

    /// Publish (spend_pubkey, view_pubkey) once. Senders derive
    /// one-time addresses; recipient scans via view key.
    pub fn register_stealth_registry(
        ctx: Context<RegisterStealthRegistry>,
        params: CreateStealthParams,
    ) -> Result<()> {
        handle_register_stealth_registry(ctx, params)
    }

    pub fn deactivate_stealth_registry(ctx: Context<DeactivateStealthRegistry>) -> Result<()> {
        handle_deactivate_stealth_registry(ctx)
    }

    /// Derive one-time address from ephemeral key + recipient's meta-address.
    pub fn resolve_stealth_address(
        ctx: Context<ResolveStealthAddress>,
        params: ResolveStealthParams,
    ) -> Result<()> {
        handle_resolve_stealth_address(ctx, params)
    }

    /// Claim via spend proof (stealth private key signature).
    pub fn claim_stealth_address(
        ctx: Context<ClaimStealthAddress>,
        spend_proof: [u8; 64],
    ) -> Result<()> {
        handle_claim_stealth_address(ctx, spend_proof)
    }

    pub fn propose_fee_update(
        ctx: Context<ProposeFeeUpdate>,
        new_fee_bps: u16,
        new_burn_ratio_bps: u16,
    ) -> Result<()> {
        handle_propose_fee_update(ctx, new_fee_bps, new_burn_ratio_bps)
    }

    pub fn execute_fee_update(ctx: Context<ExecuteFeeUpdate>) -> Result<()> {
        handle_execute_fee_update(ctx)
    }

    pub fn cancel_fee_proposal(ctx: Context<CancelFeeProposal>) -> Result<()> {
        handle_cancel_fee_proposal(ctx)
    }

    pub fn add_supported_mint(ctx: Context<AddSupportedMint>) -> Result<()> {
        handle_add_supported_mint(ctx)
    }

    pub fn remove_supported_mint(ctx: Context<RemoveSupportedMint>) -> Result<()> {
        handle_remove_supported_mint(ctx)
    }

    pub fn initiate_authority_transfer(ctx: Context<InitiateAuthorityTransfer>) -> Result<()> {
        handle_initiate_authority_transfer(ctx)
    }

    pub fn accept_authority_transfer(ctx: Context<AcceptAuthorityTransfer>) -> Result<()> {
        handle_accept_authority_transfer(ctx)
    }

    pub fn freeze_pool(ctx: Context<FreezePool>, reason: String) -> Result<()> {
        handle_freeze_pool(ctx, reason)
    }

    pub fn unfreeze_pool(ctx: Context<FreezePool>) -> Result<()> {
        handle_unfreeze_pool(ctx)
    }

    pub fn burn_fees(ctx: Context<BurnFees>, amount: u64) -> Result<()> {
        handle_burn_fees(ctx, amount)
    }

    pub fn update_governance_signers(
        ctx: Context<UpdateGovernanceSigners>,
        signers: Vec<Pubkey>,
        required: u8,
    ) -> Result<()> {
        handle_update_governance_signers(ctx, signers, required)
    }
}
// rev1
