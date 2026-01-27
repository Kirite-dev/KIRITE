use anchor_lang::prelude::*;

/// Maximum number of stealth addresses tracked per registry.
pub const MAX_STEALTH_ENTRIES: usize = 256;

/// A stealth meta-address registry for a user.
/// Each user publishes their (spend_pubkey, view_pubkey) so that senders
/// can derive one-time stealth addresses without interaction.
///
/// PDA seeded by `["stealth_registry", owner]`.
#[account]
pub struct StealthRegistry {
    /// The wallet that owns this registry.
    pub owner: Pubkey,

    /// The public spend key (compressed Curve25519 point).
    /// Used in the final stealth address derivation.
    pub spend_pubkey: [u8; 32],

    /// The public view key (compressed Curve25519 point).
    /// Senders use this to create the shared secret.
    pub view_pubkey: [u8; 32],

    /// Number of stealth addresses derived for this registry.
    pub address_count: u64,

    /// Whether this registry is active. Can be deactivated by owner.
    pub is_active: bool,

    /// Timestamp of creation.
    pub created_at: i64,

    /// Last time a stealth address was derived using this registry.
    pub last_used_at: i64,

    /// Bump seed.
    pub bump: u8,

    pub _reserved: [u8; 64],
}

impl StealthRegistry {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 1 + 8 + 8 + 1 + 64;
}

/// A resolved stealth address record. Created when a sender derives a
/// one-time address for a recipient.
///
/// PDA seeded by `["stealth_address", registry, ephemeral_pubkey]`.
#[account]
pub struct StealthAddress {
    /// The registry this stealth address was derived from.
    pub registry: Pubkey,

    /// The one-time Solana address (derived deterministically).
    pub address: Pubkey,

    /// The ephemeral public key the sender published so the recipient
    /// can scan and detect this payment.
    pub ephemeral_pubkey: [u8; 32],

    /// The token mint for this stealth payment (Pubkey::default for SOL).
    pub mint: Pubkey,

    /// Encrypted amount (ElGamal ciphertext under recipient's view key).
    pub encrypted_amount: [u8; 64],

    /// Whether the recipient has claimed / swept this stealth address.
    pub is_claimed: bool,

    /// Timestamp of creation.
    pub created_at: i64,

    /// Timestamp when claimed (0 if unclaimed).
    pub claimed_at: i64,

    /// Bump seed.
    pub bump: u8,
}

impl StealthAddress {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 32 + 64 + 1 + 8 + 8 + 1;
}

/// Ephemeral key announcement stored on-chain so recipients can scan
/// for payments addressed to them. This is the "announcement log" pattern
/// similar to Ethereum stealth address ERC-5564.
///
/// PDA seeded by `["ephemeral_key", stealth_address]`.
#[account]
pub struct EphemeralKeyRecord {
    /// The stealth address this ephemeral key resolves to.
    pub stealth_address: Pubkey,

    /// The registry (meta-address) of the intended recipient.
    pub registry: Pubkey,

    /// The ephemeral public key R = r*G.
    pub ephemeral_pubkey: [u8; 32],

    /// A view tag — first byte of the shared secret — used for fast
    /// scanning. Recipients compute `H(view_key * R)[0]` and compare
    /// to this tag; non-matching entries are skipped cheaply.
    pub view_tag: u8,

    /// Timestamp.
    pub created_at: i64,

    /// Bump seed.
    pub bump: u8,
}

impl EphemeralKeyRecord {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 1 + 8 + 1;
}

/// Parameters for creating a new stealth address.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateStealthParams {
    pub spend_pubkey: [u8; 32],
    pub view_pubkey: [u8; 32],
}

/// Parameters for resolving (deriving) a stealth address for a recipient.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ResolveStealthParams {
    pub ephemeral_pubkey: [u8; 32],
    pub ephemeral_secret: [u8; 32],
    pub encrypted_amount: [u8; 64],
    pub mint: Pubkey,
}
