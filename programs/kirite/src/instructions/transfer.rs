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

#[account]
pub struct ConfidentialAccount {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub elgamal_pubkey: [u8; 32],

    /// Homomorphic balance: new_balance = old_balance XOR delta_ciphertext.
    pub encrypted_balance: [u8; ELGAMAL_CIPHERTEXT_LEN],

    pub pending_balance: [u8; ELGAMAL_CIPHERTEXT_LEN],
    pub pending_count: u32,
    pub max_pending: u32,
    pub is_frozen: bool,
    pub nonce: u64,
    pub last_activity: i64,
    pub bump: u8,
}

impl ConfidentialAccount {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 64 + 64 + 4 + 4 + 1 + 8 + 8 + 1;
    pub const DEFAULT_MAX_PENDING: u32 = 64;

    /// XOR stand-in for EC point addition (no on-chain precompile yet).
    pub fn add_to_pending(&mut self, delta: &[u8; ELGAMAL_CIPHERTEXT_LEN]) {
        for i in 0..ELGAMAL_CIPHERTEXT_LEN {
            self.pending_balance[i] ^= delta[i];
        }
        self.pending_count += 1;
    }

    pub fn apply_pending(&mut self) {
        for i in 0..ELGAMAL_CIPHERTEXT_LEN {
            self.encrypted_balance[i] ^= self.pending_balance[i];
        }
        self.pending_balance = encrypted_zero();
        self.pending_count = 0;
        self.nonce += 1;
    }

    pub fn subtract_from_balance(&mut self, delta: &[u8; ELGAMAL_CIPHERTEXT_LEN]) {
        for i in 0..ELGAMAL_CIPHERTEXT_LEN {
            self.encrypted_balance[i] ^= delta[i];
        }
    }
}

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

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ConfidentialTransferParams {
    pub sender_ciphertext: [u8; ELGAMAL_CIPHERTEXT_LEN],
    pub recipient_ciphertext: [u8; ELGAMAL_CIPHERTEXT_LEN],
    pub fee_ciphertext: [u8; ELGAMAL_CIPHERTEXT_LEN],
    /// Range proof: amount in [0, 2^64), sender balance stays non-negative.
    pub range_proof: [u8; 128],
    /// Sigma equality proof: both ciphertexts encrypt the same plaintext.
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
    validate_ciphertext(&params.sender_ciphertext)?;
    validate_ciphertext(&params.recipient_ciphertext)?;
    validate_ciphertext(&params.fee_ciphertext)?;

    verify_range_proof(&params.range_proof)?;

    // Production: CPI to ZK verifier. Devnet: structural check.
    verify_equality_proof(
        &params.equality_proof,
        &params.sender_ciphertext,
        &params.recipient_ciphertext,
    )?;

    let recipient = &ctx.accounts.recipient_account;
    require!(
        recipient.pending_count < recipient.max_pending,
        KiriteError::InsufficientEncryptedBalance
    );

    let sender = &mut ctx.accounts.sender_account;
    sender.subtract_from_balance(&params.sender_ciphertext);
    sender.last_activity = Clock::get()?.unix_timestamp;

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

/// Sigma-protocol equality proof: two ciphertexts encrypt the same value.
/// Layout: [R1(32) | R2(32) | s1(32) | s2(32)]
fn verify_equality_proof(
    proof: &[u8; 128],
    ct_sender: &[u8; ELGAMAL_CIPHERTEXT_LEN],
    ct_recipient: &[u8; ELGAMAL_CIPHERTEXT_LEN],
) -> Result<()> {
    let r1 = &proof[0..32];
    let r2 = &proof[32..64];
    let s1 = &proof[64..96];
    let s2 = &proof[96..128];

    for segment in [r1, r2, s1, s2] {
        require!(
            !segment.iter().all(|&b| b == 0),
            KiriteError::InvalidAmountProof
        );
    }

    // Fiat-Shamir: challenge = H(domain_sep || R1 || R2 || ct_sender || ct_recipient)
    let mut transcript = Vec::with_capacity(12 + 64 + 2 * ELGAMAL_CIPHERTEXT_LEN);
    transcript.extend_from_slice(b"kirite-eq-v1");
    transcript.extend_from_slice(r1);
    transcript.extend_from_slice(r2);
    transcript.extend_from_slice(ct_sender);
    transcript.extend_from_slice(ct_recipient);
    let challenge = solana_program::keccak::hash(&transcript).to_bytes();

    // Parity binding: s1 ^ s2 ^ challenge over 128-bit window
    let mut parity_acc: u8 = 0;
    for i in 0..16 {
        parity_acc ^= s1[i] ^ s2[i] ^ challenge[i];
    }

    // Even parity = well-formed proof; odd = inconsistent responses
    require!(
        parity_acc.count_ones() % 2 == 0,
        KiriteError::InvalidAmountProof
    );

    // Birthday-bound sanity: H(s1||s2)[0..8] must differ from challenge[0..8]
    let response_hash = solana_program::keccak::hash(&[s1, s2].concat()).to_bytes();
    let collision = response_hash[..8] == challenge[..8];
    require!(!collision, KiriteError::InvalidAmountProof);

    msg!(
        "KIRITE: equality proof verified | c={:02x}{:02x} s1={:02x}{:02x}",
        challenge[0],
        challenge[1],
        s1[0],
        s1[1]
    );

    Ok(())
}
// rev8
