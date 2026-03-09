use anchor_lang::prelude::*;
use solana_program::keccak;

use crate::errors::KiriteError;

/// Compressed point representation for Twisted ElGamal on Curve25519.
pub const COMPRESSED_POINT_LEN: usize = 32;
pub const ELGAMAL_CIPHERTEXT_LEN: usize = 64; // (C1 || C2), two compressed points

// ============================================================================
// Commitment Hashing
// ============================================================================

/// Compute a Pedersen-style commitment hash for a shield-pool deposit.
///
/// commitment = H(nullifier_secret || amount || blinding_factor || leaf_index)
pub fn compute_commitment(
    nullifier_secret: &[u8; 32],
    amount: u64,
    blinding_factor: &[u8; 32],
    leaf_index: u32,
) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(32 + 8 + 32 + 4);
    preimage.extend_from_slice(nullifier_secret);
    preimage.extend_from_slice(&amount.to_le_bytes());
    preimage.extend_from_slice(blinding_factor);
    preimage.extend_from_slice(&leaf_index.to_le_bytes());
    keccak::hash(&preimage).to_bytes()
}

/// Compute the nullifier hash that is revealed at withdrawal time.
///
/// nullifier_hash = H(nullifier_secret || leaf_index || "kirite_nullifier")
pub fn compute_nullifier_hash(nullifier_secret: &[u8; 32], leaf_index: u32) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(32 + 4 + 16);
    preimage.extend_from_slice(nullifier_secret);
    preimage.extend_from_slice(&leaf_index.to_le_bytes());
    preimage.extend_from_slice(b"kirite_nullifier");
    keccak::hash(&preimage).to_bytes()
}

// ============================================================================
// Merkle Tree Helpers
// ============================================================================

/// Devnet: 5 (32 leaves). Mainnet: 20 (1M leaves)
pub const MERKLE_TREE_HEIGHT: usize = 5;
pub const MERKLE_TREE_CAPACITY: u32 = 1 << MERKLE_TREE_HEIGHT;

/// The "zero value" leaf used to initialise empty positions.
/// H("kirite_empty_leaf")
pub fn empty_leaf() -> [u8; 32] {
    keccak::hash(b"kirite_empty_leaf").to_bytes()
}

/// Hash two 32-byte siblings together to form a parent node.
///
/// parent = H(left || right)
pub fn hash_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut combined = [0u8; 64];
    combined[..32].copy_from_slice(left);
    combined[32..].copy_from_slice(right);
    keccak::hash(&combined).to_bytes()
}

/// Compute zero hash at a given level on-the-fly to avoid stack allocation.
/// zeros[0] = empty_leaf, zeros[i] = H(zeros[i-1] || zeros[i-1])
#[inline(never)]
pub fn zero_hash_at_level(level: usize) -> [u8; 32] {
    let mut h = empty_leaf();
    for _ in 0..level {
        h = hash_pair(&h, &h);
    }
    h
}

/// Compute the set of default ("zero") hashes for each tree level.
/// `zeros[0]` is the empty leaf, `zeros[i] = H(zeros[i-1] || zeros[i-1])`.
pub fn compute_zero_hashes() -> [[u8; 32]; MERKLE_TREE_HEIGHT + 1] {
    let mut zeros = [[0u8; 32]; MERKLE_TREE_HEIGHT + 1];
    zeros[0] = empty_leaf();
    for i in 1..=MERKLE_TREE_HEIGHT {
        zeros[i] = hash_pair(&zeros[i - 1], &zeros[i - 1]);
    }
    zeros
}

/// Verify a Merkle inclusion proof.
pub fn verify_merkle_proof(
    leaf: &[u8; 32],
    proof: &[[u8; 32]],
    index: u32,
    root: &[u8; 32],
) -> bool {
    if proof.len() != MERKLE_TREE_HEIGHT {
        return false;
    }

    let mut current = *leaf;
    let mut idx = index;

    for sibling in proof.iter() {
        if idx & 1 == 0 {
            current = hash_pair(&current, sibling);
        } else {
            current = hash_pair(sibling, &current);
        }
        idx >>= 1;
    }

    current == *root
}

/// Insert a leaf into a sparse Merkle tree and return the new root.
/// Stack-optimized: computes zero hashes on-the-fly instead of pre-allocating array.
#[inline(never)]
pub fn insert_leaf(
    leaf: &[u8; 32],
    next_index: u32,
    filled_subtrees: &mut [[u8; 32]; MERKLE_TREE_HEIGHT],
    _zero_hashes: &[[u8; 32]; MERKLE_TREE_HEIGHT + 1],
) -> Result<[u8; 32]> {
    require!(
        next_index < MERKLE_TREE_CAPACITY,
        KiriteError::PoolCapacityExceeded
    );

    let mut current = *leaf;
    let mut idx = next_index;

    for i in 0..MERKLE_TREE_HEIGHT {
        if idx & 1 == 0 {
            filled_subtrees[i] = current;
            let zh = zero_hash_at_level(i);
            current = hash_pair(&current, &zh);
        } else {
            current = hash_pair(&filled_subtrees[i], &current);
        }
        idx >>= 1;
    }

    Ok(current)
}

/// Insert a leaf without requiring pre-computed zero hashes (stack-friendly).
#[inline(never)]
pub fn insert_leaf_light(
    leaf: &[u8; 32],
    next_index: u32,
    filled_subtrees: &mut [[u8; 32]; MERKLE_TREE_HEIGHT],
) -> Result<[u8; 32]> {
    require!(
        next_index < MERKLE_TREE_CAPACITY,
        KiriteError::PoolCapacityExceeded
    );

    let mut current = *leaf;
    let mut idx = next_index;

    for i in 0..MERKLE_TREE_HEIGHT {
        if idx & 1 == 0 {
            filled_subtrees[i] = current;
            let zh = zero_hash_at_level(i);
            current = hash_pair(&current, &zh);
        } else {
            current = hash_pair(&filled_subtrees[i], &current);
        }
        idx >>= 1;
    }

    Ok(current)
}

// ============================================================================
// Range Proof (stub — real verification via Solana syscall in production)
// ============================================================================

pub fn verify_range_proof(proof: &[u8]) -> Result<()> {
    require!(!proof.is_empty(), KiriteError::InvalidAmountProof);
    require!(proof.iter().any(|&b| b != 0), KiriteError::InvalidAmountProof);
    Ok(())
}

// ============================================================================
// Stealth Address Helpers
// ============================================================================

pub fn compute_ephemeral_pubkey(secret: &[u8; 32]) -> [u8; 32] {
    keccak::hash(secret).to_bytes()
}

pub fn derive_stealth_pubkey(
    spend_pubkey: &[u8; 32],
    view_pubkey: &[u8; 32],
    ephemeral_secret: &[u8; 32],
) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(96);
    preimage.extend_from_slice(spend_pubkey);
    preimage.extend_from_slice(view_pubkey);
    preimage.extend_from_slice(ephemeral_secret);
    keccak::hash(&preimage).to_bytes()
}

// ============================================================================
// ElGamal Helpers
// ============================================================================

/// Basic ciphertext validation. Verifies the ciphertext is not all zeros
/// and is the correct length. Full cryptographic validation happens
/// off-chain; on-chain we only check the proof.
pub fn validate_ciphertext(ct: &[u8; ELGAMAL_CIPHERTEXT_LEN]) -> Result<()> {
    let all_zero = ct.iter().all(|&b| b == 0);
    require!(!all_zero, KiriteError::InvalidAmountProof);
    Ok(())
}

/// Validate that an ElGamal public key is non-zero.
pub fn validate_elgamal_pubkey(pk: &[u8; 32]) -> Result<()> {
    let all_zero = pk.iter().all(|&b| b == 0);
    require!(!all_zero, KiriteError::InvalidAmountProof);
    Ok(())
}

/// Return a zero-valued ciphertext (64 zero bytes).
pub fn encrypted_zero() -> [u8; ELGAMAL_CIPHERTEXT_LEN] {
    // A real implementation would encrypt 0 under the owner's key.
    // For the MVP we store a sentinel that the client knows to interpret as zero.
    [0u8; ELGAMAL_CIPHERTEXT_LEN]
}

// ============================================================================
// Merkle proof verification for withdrawals
// ============================================================================

/// Verify a withdrawal proof against the pool's Merkle root.
pub fn verify_withdrawal_proof(
    nullifier_secret: &[u8; 32],
    blinding_factor: &[u8; 32],
    denomination: u64,
    leaf_index: u32,
    proof: &[[u8; 32]; MERKLE_TREE_HEIGHT],
    root: &[u8; 32],
) -> bool {
    let commitment = compute_commitment(nullifier_secret, denomination, blinding_factor, leaf_index);
    let mut current = commitment;
    let mut idx = leaf_index;

    for i in 0..MERKLE_TREE_HEIGHT {
        if idx & 1 == 0 {
            current = hash_pair(&current, &proof[i]);
        } else {
            current = hash_pair(&proof[i], &current);
        }
        idx >>= 1;
    }

    current == *root
}
// rev9
