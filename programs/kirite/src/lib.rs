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
use instructions::transfer::*;
use instructions::withdraw::*;
use state::shield_pool::PoolConfig;
use state::stealth::{CreateStealthParams, ResolveStealthParams};

declare_id!("4bUHrDPuRcoYPU7UTLojXtxJsWoCj3HJbKX9oLnEnYy6");

#[program]
pub mod kirite {
    use super::*;

    // ========================================================================
    // Protocol Initialization
    // ========================================================================

    /// Initialize the KIRITE privacy protocol.
    ///
    /// Sets the protocol authority, fee parameters, and creates the
    /// governance state account. Must be called exactly once.
    ///
    /// # Arguments
    /// * `fee_bps` — Protocol fee in basis points (e.g., 10 = 0.1%)
    /// * `burn_ratio_bps` — Fraction of fees to burn (e.g., 5000 = 50%)
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        fee_bps: u16,
        burn_ratio_bps: u16,
    ) -> Result<()> {
        handle_initialize_protocol(ctx, fee_bps, burn_ratio_bps)
    }

    /// Create a new shield pool for a specific token denomination.
    ///
    /// Each pool accepts deposits of exactly one fixed denomination to
    /// maximise the anonymity set. Multiple pools can exist for the same
    /// token with different denominations.
    pub fn initialize_shield_pool(
        ctx: Context<InitializeShieldPool>,
        config: PoolConfig,
    ) -> Result<()> {
        handle_initialize_shield_pool(ctx, config)
    }

    /// Pause all protocol operations. Emergency use only.
    pub fn pause_protocol(ctx: Context<PauseProtocol>) -> Result<()> {
        handle_pause_protocol(ctx)
    }

    /// Resume protocol operations after a pause.
    pub fn resume_protocol(ctx: Context<PauseProtocol>) -> Result<()> {
        handle_resume_protocol(ctx)
    }

    // ========================================================================
    // Shield Pool — Deposit
    // ========================================================================

    /// Deposit tokens into a shield pool.
    ///
    /// The depositor transfers exactly `denomination` tokens into the pool
    /// vault and provides a commitment hash that is inserted into the
    /// on-chain Merkle tree. The commitment binds a secret nullifier and
    /// blinding factor so that only the holder of these secrets can
    /// withdraw later.
    ///
    /// The deposit is timelocked — it cannot be withdrawn until
    /// `timelock_seconds` have elapsed.
    pub fn deposit(ctx: Context<Deposit>, params: DepositParams) -> Result<()> {
        handle_deposit(ctx, params)
    }

    // ========================================================================
    // Shield Pool — Withdraw
    // ========================================================================

    /// Withdraw tokens from a shield pool to any recipient.
    ///
    /// The withdrawer proves knowledge of the nullifier secret and provides
    /// a Merkle inclusion proof. The nullifier hash is published on-chain
    /// to prevent double-spending. The link between depositor and
    /// recipient is broken because:
    ///
    /// 1. The commitment hides the nullifier and blinding factor.
    /// 2. The nullifier hash reveals nothing about the depositor.
    /// 3. The recipient can be any address.
    /// 4. A relayer submits the transaction so the recipient pays no gas.
    pub fn withdraw(ctx: Context<Withdraw>, params: WithdrawParams) -> Result<()> {
        handle_withdraw(ctx, params)
    }

    // ========================================================================
    // Confidential Transfer
    // ========================================================================

    /// Create a confidential token account with an ElGamal public key.
    ///
    /// The account stores an encrypted balance that can only be decrypted
    /// by the owner. Transfers between confidential accounts update the
    /// ciphertexts homomorphically without revealing amounts on-chain.
    pub fn create_confidential_account(
        ctx: Context<CreateConfidentialAccount>,
        elgamal_pubkey: [u8; 32],
    ) -> Result<()> {
        handle_create_confidential_account(ctx, elgamal_pubkey)
    }

    /// Execute a confidential transfer between two accounts.
    ///
    /// The sender provides:
    /// - Ciphertext of the amount under their own key (for balance update)
    /// - Ciphertext of the amount under the recipient's key
    /// - A range proof (amount >= 0 and sender balance stays non-negative)
    /// - An equality proof (both ciphertexts encrypt the same value)
    ///
    /// No plaintext amounts are ever revealed on-chain.
    pub fn confidential_transfer(
        ctx: Context<ConfidentialTransfer>,
        params: ConfidentialTransferParams,
    ) -> Result<()> {
        handle_confidential_transfer(ctx, params)
    }

    /// Apply pending incoming transfers to the main encrypted balance.
    ///
    /// Recipients must periodically apply their pending balance to keep
    /// their account in sync. This is a separate instruction to allow
    /// the recipient to decrypt and verify pending amounts off-chain
    /// before applying.
    pub fn apply_pending_balance(
        ctx: Context<ApplyPendingBalance>,
        expected_nonce: u64,
    ) -> Result<()> {
        handle_apply_pending_balance(ctx, expected_nonce)
    }

    // ========================================================================
    // Stealth Addresses
    // ========================================================================

    /// Register a stealth meta-address (spend_pubkey, view_pubkey).
    ///
    /// This is published once per user. Senders look up the recipient's
    /// registry and derive a one-time stealth address for each payment.
    /// The recipient scans ephemeral key announcements using their view
    /// key to detect incoming payments.
    pub fn register_stealth_registry(
        ctx: Context<RegisterStealthRegistry>,
        params: CreateStealthParams,
    ) -> Result<()> {
        handle_register_stealth_registry(ctx, params)
    }

    /// Deactivate a stealth registry. No new stealth addresses can be
    /// derived after deactivation, but existing addresses remain valid.
    pub fn deactivate_stealth_registry(ctx: Context<DeactivateStealthRegistry>) -> Result<()> {
        handle_deactivate_stealth_registry(ctx)
    }

    /// Derive a one-time stealth address for a recipient.
    ///
    /// The sender generates an ephemeral keypair and uses the recipient's
    /// view pubkey to create a shared secret. The stealth address is
    /// derived by combining the shared secret with the recipient's spend
    /// pubkey. An ephemeral key announcement is published on-chain so
    /// the recipient can scan for it.
    pub fn resolve_stealth_address(
        ctx: Context<ResolveStealthAddress>,
        params: ResolveStealthParams,
    ) -> Result<()> {
        handle_resolve_stealth_address(ctx, params)
    }

    /// Claim a stealth address by proving ownership of the spend key.
    ///
    /// The recipient provides a spend proof (signature using the derived
    /// stealth private key) to claim the funds associated with the
    /// stealth address.
    pub fn claim_stealth_address(
        ctx: Context<ClaimStealthAddress>,
        spend_proof: [u8; 64],
    ) -> Result<()> {
        handle_claim_stealth_address(ctx, spend_proof)
    }

    // ========================================================================
    // Governance
    // ========================================================================

    /// Propose a fee update. Subject to timelock before execution.
    pub fn propose_fee_update(
        ctx: Context<ProposeFeeUpdate>,
        new_fee_bps: u16,
        new_burn_ratio_bps: u16,
    ) -> Result<()> {
        handle_propose_fee_update(ctx, new_fee_bps, new_burn_ratio_bps)
    }

    /// Execute a fee update after the timelock has elapsed.
    pub fn execute_fee_update(ctx: Context<ExecuteFeeUpdate>) -> Result<()> {
        handle_execute_fee_update(ctx)
    }

    /// Cancel a pending fee proposal.
    pub fn cancel_fee_proposal(ctx: Context<CancelFeeProposal>) -> Result<()> {
        handle_cancel_fee_proposal(ctx)
    }

    /// Add a token mint to the supported mints list.
    pub fn add_supported_mint(ctx: Context<AddSupportedMint>) -> Result<()> {
        handle_add_supported_mint(ctx)
    }

    /// Remove a token mint from the supported mints list.
    pub fn remove_supported_mint(ctx: Context<RemoveSupportedMint>) -> Result<()> {
        handle_remove_supported_mint(ctx)
    }

    /// Initiate a two-step authority transfer.
    pub fn initiate_authority_transfer(ctx: Context<InitiateAuthorityTransfer>) -> Result<()> {
        handle_initiate_authority_transfer(ctx)
    }

    /// Accept a pending authority transfer.
    pub fn accept_authority_transfer(ctx: Context<AcceptAuthorityTransfer>) -> Result<()> {
        handle_accept_authority_transfer(ctx)
    }

    /// Freeze a shield pool (prevent deposits and withdrawals).
    pub fn freeze_pool(ctx: Context<FreezePool>, reason: String) -> Result<()> {
        handle_freeze_pool(ctx, reason)
    }

    /// Unfreeze a previously frozen shield pool.
    pub fn unfreeze_pool(ctx: Context<FreezePool>) -> Result<()> {
        handle_unfreeze_pool(ctx)
    }

    /// Burn accumulated protocol fees.
    pub fn burn_fees(ctx: Context<BurnFees>, amount: u64) -> Result<()> {
        handle_burn_fees(ctx, amount)
    }

    /// Update governance signer set and threshold.
    pub fn update_governance_signers(
        ctx: Context<UpdateGovernanceSigners>,
        signers: Vec<Pubkey>,
        required: u8,
    ) -> Result<()> {
        handle_update_governance_signers(ctx, signers, required)
    }
}
// rev1
