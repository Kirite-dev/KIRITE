use anchor_lang::prelude::*;

#[event]
pub struct ProtocolInitialized {
    pub authority: Pubkey,
    pub protocol_config: Pubkey,
    pub fee_basis_points: u16,
    pub timestamp: i64,
}

#[event]
pub struct ProtocolPaused {
    pub authority: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct ProtocolResumed {
    pub authority: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct ShieldPoolCreated {
    pub pool: Pubkey,
    pub mint: Pubkey,
    pub denomination: u64,
    pub operator: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct DepositCommitted {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub commitment_hash: [u8; 32],
    pub encrypted_amount: [u8; 64],
    pub leaf_index: u32,
    pub timestamp: i64,
}

#[event]
pub struct WithdrawalExecuted {
    pub pool: Pubkey,
    pub recipient: Pubkey,
    pub nullifier_hash: [u8; 32],
    pub fee_amount: u64,
    pub net_amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct PoolFrozen {
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub reason: String,
    pub timestamp: i64,
}

#[event]
pub struct StealthAddressRegistered {
    pub owner: Pubkey,
    pub registry: Pubkey,
    pub spend_pubkey: [u8; 32],
    pub view_pubkey: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct StealthAddressResolved {
    pub registry: Pubkey,
    pub ephemeral_pubkey: [u8; 32],
    pub stealth_address: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct FeeUpdated {
    pub authority: Pubkey,
    pub old_fee_bps: u16,
    pub new_fee_bps: u16,
    pub effective_at: i64,
    pub timestamp: i64,
}

#[event]
pub struct MintAdded {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct MintRemoved {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct AuthorityTransferred {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct BurnExecuted {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}
// rev3
