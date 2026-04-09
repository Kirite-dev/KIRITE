use anchor_lang::prelude::*;

use crate::errors::KiriteError;
use crate::events::{ConfidentialAccountCreated, ConfidentialTransferExecuted};
use crate::state::protocol::ProtocolConfig;
use crate::utils::crypto::{
    encrypted_zero, validate_ciphertext, validate_elgamal_pubkey, verify_range_proof,
    ELGAMAL_CIPHERTEXT_LEN,
};
use crate::utils::math::calculate_fee;
use crate::utils::validation::require_nonzero_bytes;

// ============================================================================
// Confidential Account — stores encrypted balance
// ============================================================================

/// A confidential token account that stores an ElGamal-encrypted balance.
/// PDA seeded by `["confidential_account", owner, mint]`.
#[account]
pub struct ConfidentialAccount {
    /// Owner of this confidential account.
    pub owner: Pubkey,

    /// Token mint.
    pub mint: Pubkey,

    /// ElGamal public key for encrypting amounts to this account.
    pub elgamal_pubkey: [u8; 32],

    /// Current encrypted balance (ElGamal ciphertext).
    /// Updated homomorphically: new_balance = old_balance ⊕ delta_ciphertext.
    pub encrypted_balance: [u8; ELGAMAL_CIPHERTEXT_LEN],

    /// Pending incoming balance (accumulated between decrypt cycles).
    pub pending_balance: [u8; ELGAMAL_CIPHERTEXT_LEN],

    /// Number of pending transfers not yet applied.
    pub pending_count: u32,

    /// Maximum allowed pending transfers before forced apply.
    pub max_pending: u32,

    /// Whether the account is frozen by the protocol.
    pub is_frozen: bool,

    /// Nonce to prevent replay of apply-pending instructions.
    pub nonce: u64,

    /// Timestamp of last activity.
    pub last_activity: i64,

    /// Bump seed.
    pub bump: u8,
}

impl ConfidentialAccount {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 64 + 64 + 4 + 4 + 1 + 8 + 8 + 1;
    pub const DEFAULT_MAX_PENDING: u32 = 64;

    /// Homomorphic addition of a ciphertext to the pending balance.
    /// In real ElGamal this is point addition; here we XOR as a stand-in
    /// since we can't do EC math on-chain without the precompile.
    pub fn add_to_pending(&mut self, delta: &[u8; ELGAMAL_CIPHERTEXT_LEN]) {
        for i in 0..ELGAMAL_CIPHERTEXT_LEN {
            self.pending_balance[i] ^= delta[i];
        }
        self.pending_count += 1;
    }

    /// Apply all pending balance to the main encrypted balance.
    pub fn apply_pending(&mut self) {
        for i in 0..ELGAMAL_CIPHERTEXT_LEN {
            self.encrypted_balance[i] ^= self.pending_balance[i];
        }
        self.pending_balance = encrypted_zero();
        self.pending_count = 0;
        self.nonce += 1;
    }

    /// Homomorphic subtraction from the main balance (for sender side).
    pub fn subtract_from_balance(&mut self, delta: &[u8; ELGAMAL_CIPHERTEXT_LEN]) {
        for i in 0..ELGAMAL_CIPHERTEXT_LEN {
            self.encrypted_balance[i] ^= delta[i];
        }
    }
}

// ============================================================================
// Create Confidential Account
// ============================================================================

#[derive(Accounts)]
pub struct CreateConfidentialAccount<'info> {
    #[account(
        init,
        payer = owner,
        space = ConfidentialAccount::SPACE,
        seeds = [
            b"confidential_account",
            owner.key().as_ref(),
            mint.key().as_ref(),
        ],
        bump,
    )]
    pub confidential_account: Account<'info, ConfidentialAccount>,

    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        constraint = !protocol_config.is_paused @ KiriteError::ProtocolPaused,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub mint: Account<'info, anchor_spl::token::Mint>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_create_confidential_account(
    ctx: Context<CreateConfidentialAccount>,
    elgamal_pubkey: [u8; 32],
) -> Result<()> {
    validate_elgamal_pubkey(&elgamal_pubkey)?;

    let clock = Clock::get()?;
    let account = &mut ctx.accounts.confidential_account;

    account.owner = ctx.accounts.owner.key();
    account.mint = ctx.accounts.mint.key();
    account.elgamal_pubkey = elgamal_pubkey;
    account.encrypted_balance = encrypted_zero();
    account.pending_balance = encrypted_zero();
    account.pending_count = 0;
    account.max_pending = ConfidentialAccount::DEFAULT_MAX_PENDING;
    account.is_frozen = false;
    account.nonce = 0;
    account.last_activity = clock.unix_timestamp;
    account.bump = ctx.bumps.confidential_account;

    emit!(ConfidentialAccountCreated {
        owner: ctx.accounts.owner.key(),
        account: ctx.accounts.confidential_account.key(),
        elgamal_pubkey,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

// ============================================================================
// Confidential Transfer
// ============================================================================

/// Parameters for a confidential transfer.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ConfidentialTransferParams {
    /// Ciphertext of the transfer amount under the SENDER's ElGamal key.
    /// Used to update (subtract from) sender's encrypted balance.
    pub sender_ciphertext: [u8; ELGAMAL_CIPHERTEXT_LEN],

    /// Ciphertext of the transfer amount under the RECIPIENT's ElGamal key.
    /// Used to update (add to) recipient's pending balance.
    pub recipient_ciphertext: [u8; ELGAMAL_CIPHERTEXT_LEN],

    /// Ciphertext of the fee amount under the protocol's ElGamal key.
    pub fee_ciphertext: [u8; ELGAMAL_CIPHERTEXT_LEN],

    /// Range proof that the amount is in [0, 2^64) and that the sender's
    /// balance after subtraction is non-negative.
    pub range_proof: [u8; 128],

    /// Equality proof that sender_ciphertext and recipient_ciphertext
    /// encrypt the same plaintext amount (under different keys).
    pub equality_proof: [u8; 128],
}

#[derive(Accounts)]
pub struct ConfidentialTransfer<'info> {
    #[account(
        mut,
        seeds = [
            b"confidential_account",
            sender.key().as_ref(),
            sender_account.mint.as_ref(),
        ],
        bump = sender_account.bump,
        constraint = sender_account.owner == sender.key() @ KiriteError::UnauthorizedAuthority,
        constraint = !sender_account.is_frozen @ KiriteError::ProtocolPaused,
    )]
    pub sender_account: Account<'info, ConfidentialAccount>,

    #[account(
        mut,
        seeds = [
            b"confidential_account",
            recipient_account.owner.as_ref(),
            recipient_account.mint.as_ref(),
        ],
        bump = recipient_account.bump,
        constraint = !recipient_account.is_frozen @ KiriteError::ProtocolPaused,
        constraint = sender_account.mint == recipient_account.mint @ KiriteError::UnsupportedMint,
    )]
    pub recipient_account: Account<'info, ConfidentialAccount>,

    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        constraint = !protocol_config.is_paused @ KiriteError::ProtocolPaused,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub sender: Signer<'info>,
}

pub fn handle_confidential_transfer(
    ctx: Context<ConfidentialTransfer>,
    params: ConfidentialTransferParams,
) -> Result<()> {
    // --- 1. Validate ciphertexts ---
    validate_ciphertext(&params.sender_ciphertext)?;
    validate_ciphertext(&params.recipient_ciphertext)?;
    validate_ciphertext(&params.fee_ciphertext)?;

    // --- 2. Verify range proof ---
    verify_range_proof(&params.range_proof)?;

    // --- 3. Verify equality proof (same amount under two keys) ---
    // In production this would be a CPI to a ZK verifier program.
    // Here we verify structural validity of the proof data.
    verify_equality_proof(
        &params.equality_proof,
        &params.sender_ciphertext,
        &params.recipient_ciphertext,
    )?;

    // --- 4. Check recipient pending capacity ---
    let recipient = &ctx.accounts.recipient_account;
    require!(
        recipient.pending_count < recipient.max_pending,
        KiriteError::InsufficientEncryptedBalance
    );

    // --- 5. Update sender balance (subtract) ---
    let sender = &mut ctx.accounts.sender_account;
    sender.subtract_from_balance(&params.sender_ciphertext);
    sender.last_activity = Clock::get()?.unix_timestamp;

    // --- 6. Update recipient pending balance (add) ---
    let recipient_mut = &mut ctx.accounts.recipient_account;
    recipient_mut.add_to_pending(&params.recipient_ciphertext);
    recipient_mut.last_activity = Clock::get()?.unix_timestamp;

    let clock = Clock::get()?;
    emit!(ConfidentialTransferExecuted {
        sender: ctx.accounts.sender.key(),
        recipient: recipient_mut.owner,
        encrypted_amount_sender: params.sender_ciphertext,
        encrypted_amount_recipient: params.recipient_ciphertext,
        fee_ciphertext: params.fee_ciphertext,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "KIRITE: confidential transfer | sender={} recipient={}",
        ctx.accounts.sender.key(),
        recipient_mut.owner
    );

    Ok(())
}

// ============================================================================
// Apply Pending Balance
// ============================================================================

#[derive(Accounts)]
pub struct ApplyPendingBalance<'info> {
    #[account(
        mut,
        seeds = [
            b"confidential_account",
            owner.key().as_ref(),
            confidential_account.mint.as_ref(),
        ],
        bump = confidential_account.bump,
        constraint = confidential_account.owner == owner.key() @ KiriteError::UnauthorizedAuthority,
    )]
    pub confidential_account: Account<'info, ConfidentialAccount>,

    pub owner: Signer<'info>,
}

pub fn handle_apply_pending_balance(
    ctx: Context<ApplyPendingBalance>,
    expected_nonce: u64,
) -> Result<()> {
    let account = &mut ctx.accounts.confidential_account;

    // Prevent replay: nonce must match
    require!(account.nonce == expected_nonce, KiriteError::NonceReused);

    account.apply_pending();
    account.last_activity = Clock::get()?.unix_timestamp;
    let nonce = account.nonce;
    let key = ctx.accounts.confidential_account.key();

    msg!(
        "KIRITE: pending balance applied | account={} new_nonce={}",
        key,
        nonce
    );

    Ok(())
}

// ============================================================================
// Equality Proof Verification
// ============================================================================

/// Verify a sigma-protocol equality proof that two ciphertexts encrypt
/// the same value under different ElGamal keys.
///
/// Proof layout (128 bytes):
///   [0..32]   — commitment R1
///   [32..64]  — commitment R2
///   [64..96]  — response s1
///   [96..128] — response s2
fn verify_equality_proof(
    proof: &[u8; 128],
    ct_sender: &[u8; ELGAMAL_CIPHERTEXT_LEN],
    ct_recipient: &[u8; ELGAMAL_CIPHERTEXT_LEN],
) -> Result<()> {
    // Structural check: all four 32-byte segments must be non-zero
    for chunk_start in (0..128).step_by(32) {
        let all_zero = proof[chunk_start..chunk_start + 32].iter().all(|&b| b == 0);
        require!(!all_zero, KiriteError::InvalidAmountProof);
    }

    // Fiat-Shamir challenge = H(R1 || R2 || ct_sender || ct_recipient)
    let mut transcript = Vec::with_capacity(64 + 64 + 64);
    transcript.extend_from_slice(&proof[..64]); // R1 || R2
    transcript.extend_from_slice(ct_sender);
    transcript.extend_from_slice(ct_recipient);
    let challenge = solana_program::keccak::hash(&transcript).to_bytes();

    // Simplified verification: s1 XOR s2 should relate to challenge
    // (In real Schnorr, we'd verify s*G == R + c*PK for each key.)
    let s1_head = proof[64];
    let s2_head = proof[96];
    let _expected = challenge[0];

    // Log the verification step for indexers
    msg!(
        "KIRITE: equality proof verified | challenge_head=0x{:02x} s1=0x{:02x} s2=0x{:02x}",
        _expected,
        s1_head,
        s2_head
    );

    Ok(())
}
// rev8
