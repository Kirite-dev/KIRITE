use anchor_lang::prelude::*;

use crate::utils::crypto::MERKLE_TREE_HEIGHT;

pub const MAX_HISTORICAL_ROOTS: usize = 3;
pub const NULLIFIER_BITFIELD_BYTES: usize = 1_024;

/// Shield pool — zero_copy to avoid stack overflow on deserialization.
#[account(zero_copy)]
#[repr(C)]
pub struct ShieldPool {
    // 32-byte aligned fields first
    pub mint: Pubkey,                                       // 32
    pub operator: Pubkey,                                   // 32
    pub protocol_config: Pubkey,                            // 32
    pub vault: Pubkey,                                      // 32
    pub current_root: [u8; 32],                             // 32
    pub historical_roots: [[u8; 32]; MAX_HISTORICAL_ROOTS], // 96
    pub filled_subtrees: [[u8; 32]; MERKLE_TREE_HEIGHT],    // 160
    // 8-byte aligned fields
    pub denomination: u64,      // 8
    pub total_deposits: u64,    // 8
    pub total_withdrawals: u64, // 8
    pub fees_collected: u64,    // 8
    pub timelock_seconds: i64,  // 8
    pub created_at: i64,        // 8
    // 4-byte aligned
    pub next_leaf_index: u32, // 4
    // 1-byte fields grouped
    pub root_history_index: u8, // 1
    pub is_frozen: u8,          // 1
    pub bump: u8,               // 1
    pub vault_authority_bump: u8, // 1
                                // total should be aligned (no padding needed)
}

impl ShieldPool {
    pub const SPACE: usize = 8 + std::mem::size_of::<ShieldPool>();

    pub fn push_root(&mut self, root: [u8; 32]) {
        let idx = self.root_history_index as usize;
        self.historical_roots[idx] = root;
        self.root_history_index = ((idx + 1) % MAX_HISTORICAL_ROOTS) as u8;
        self.current_root = root;
    }

    pub fn is_known_root(&self, root: &[u8; 32]) -> bool {
        if self.current_root == *root {
            return true;
        }
        self.historical_roots.iter().any(|r| r == root)
    }

    pub fn frozen(&self) -> bool {
        self.is_frozen != 0
    }
}

/// Deposit entry — regular account (small enough for stack).
#[account]
pub struct PoolEntry {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub commitment_hash: [u8; 32],
    pub leaf_index: u32,
    pub deposited_at: i64,
    pub is_withdrawn: bool,
    pub bump: u8,
}

impl PoolEntry {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 4 + 8 + 1 + 1;
}

/// Nullifier set — regular account.
#[account]
pub struct NullifierSet {
    pub pool: Pubkey,
    pub count: u64,
    pub bump: u8,
    pub bitfield: Vec<u8>,
}

impl NullifierSet {
    pub const SPACE: usize = 8 + 32 + 8 + 1 + 4 + NULLIFIER_BITFIELD_BYTES;

    pub fn is_consumed(&self, leaf_index: u32) -> bool {
        let byte_idx = (leaf_index / 8) as usize;
        let bit_mask = 1u8 << (leaf_index % 8);
        if byte_idx >= self.bitfield.len() {
            return false;
        }
        self.bitfield[byte_idx] & bit_mask != 0
    }

    pub fn consume(&mut self, leaf_index: u32) -> bool {
        let byte_idx = (leaf_index / 8) as usize;
        let bit_mask = 1u8 << (leaf_index % 8);
        if byte_idx >= self.bitfield.len() {
            self.bitfield.resize(byte_idx + 1, 0);
        }
        if self.bitfield[byte_idx] & bit_mask != 0 {
            return false;
        }
        self.bitfield[byte_idx] |= bit_mask;
        self.count += 1;
        true
    }
}

/// Pool configuration parameters for pool creation.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PoolConfig {
    pub denomination: u64,
    pub timelock_seconds: i64,
}
// rev5
