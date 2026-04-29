use anchor_lang::prelude::*;
use solana_program::keccak;

use crate::errors::KiriteError;

pub const COMPRESSED_POINT_LEN: usize = 32;
/// Twisted ElGamal ciphertext: (Pedersen commitment C, decryption handle D).
/// Each component is a compressed Ristretto point (32 bytes).
pub const ELGAMAL_CIPHERTEXT_LEN: usize = 64;

// ---------------------------------------------------------------------------
// Ristretto point arithmetic helpers
// ---------------------------------------------------------------------------
// Ciphertexts are stored as two compressed Ristretto255 points [C(32) || D(32)].
// Homomorphic addition = component-wise elliptic curve point addition.
// We use curve25519-dalek for decompression → add → recompress.
// On-chain compute cost: ~30k CU per addition (2 decompressions + 2 additions
// + 2 compressions). Fits comfortably in the 200k default budget.

use curve25519_dalek::ristretto::CompressedRistretto;

/// Add two compressed Ristretto points. Returns None if either point is
/// not a valid encoding (decompression fails).
fn ristretto_add(a: &[u8; 32], b: &[u8; 32]) -> Option<[u8; 32]> {
    let pa = CompressedRistretto::from_slice(a).ok()?.decompress()?;
    let pb = CompressedRistretto::from_slice(b).ok()?.decompress()?;
    Some((pa + pb).compress().to_bytes())
}

/// Subtract: a - b on the Ristretto group.
fn ristretto_sub(a: &[u8; 32], b: &[u8; 32]) -> Option<[u8; 32]> {
    let pa = CompressedRistretto::from_slice(a).ok()?.decompress()?;
    let pb = CompressedRistretto::from_slice(b).ok()?.decompress()?;
    Some((pa - pb).compress().to_bytes())
}

/// Homomorphic addition of two ElGamal ciphertexts.
/// ct = (C, D), each 32 bytes. result.C = a.C + b.C, result.D = a.D + b.D.
pub fn ciphertext_add(
    a: &[u8; ELGAMAL_CIPHERTEXT_LEN],
    b: &[u8; ELGAMAL_CIPHERTEXT_LEN],
) -> Result<[u8; ELGAMAL_CIPHERTEXT_LEN]> {
    let c_a: [u8; 32] = a[..32].try_into().unwrap();
    let d_a: [u8; 32] = a[32..].try_into().unwrap();
    let c_b: [u8; 32] = b[..32].try_into().unwrap();
    let d_b: [u8; 32] = b[32..].try_into().unwrap();

    let c_sum = ristretto_add(&c_a, &c_b).ok_or_else(|| error!(KiriteError::InvalidAmountProof))?;
    let d_sum = ristretto_add(&d_a, &d_b).ok_or_else(|| error!(KiriteError::InvalidAmountProof))?;

    let mut out = [0u8; ELGAMAL_CIPHERTEXT_LEN];
    out[..32].copy_from_slice(&c_sum);
    out[32..].copy_from_slice(&d_sum);
    Ok(out)
}

/// Homomorphic subtraction of two ElGamal ciphertexts.
pub fn ciphertext_sub(
    a: &[u8; ELGAMAL_CIPHERTEXT_LEN],
    b: &[u8; ELGAMAL_CIPHERTEXT_LEN],
) -> Result<[u8; ELGAMAL_CIPHERTEXT_LEN]> {
    let c_a: [u8; 32] = a[..32].try_into().unwrap();
    let d_a: [u8; 32] = a[32..].try_into().unwrap();
    let c_b: [u8; 32] = b[..32].try_into().unwrap();
    let d_b: [u8; 32] = b[32..].try_into().unwrap();

    let c_diff =
        ristretto_sub(&c_a, &c_b).ok_or_else(|| error!(KiriteError::InvalidAmountProof))?;
    let d_diff =
        ristretto_sub(&d_a, &d_b).ok_or_else(|| error!(KiriteError::InvalidAmountProof))?;

    let mut out = [0u8; ELGAMAL_CIPHERTEXT_LEN];
    out[..32].copy_from_slice(&c_diff);
    out[32..].copy_from_slice(&d_diff);
    Ok(out)
}

// ---------------------------------------------------------------------------
// Shield Pool – Pedersen commitment & Merkle tree
// ---------------------------------------------------------------------------
// Using domain-separated keccak for Merkle hashing. When the ZK ElGamal
// program is re-enabled, transition to Poseidon for SNARK-friendly circuits.

/// commitment = H("kirite-commit-v2" || nullifier_secret || amount || blinding || leaf_index)
pub fn compute_commitment(
    nullifier_secret: &[u8; 32],
    amount: u64,
    blinding_factor: &[u8; 32],
    leaf_index: u32,
) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(16 + 32 + 8 + 32 + 4);
    preimage.extend_from_slice(b"kirite-commit-v2");
    preimage.extend_from_slice(nullifier_secret);
    preimage.extend_from_slice(&amount.to_le_bytes());
    preimage.extend_from_slice(blinding_factor);
    preimage.extend_from_slice(&leaf_index.to_le_bytes());
    keccak::hash(&preimage).to_bytes()
}

/// nullifier_hash = H("kirite-null-v2" || nullifier_secret || leaf_index)
pub fn compute_nullifier_hash(nullifier_secret: &[u8; 32], leaf_index: u32) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(14 + 32 + 4);
    preimage.extend_from_slice(b"kirite-null-v2");
    preimage.extend_from_slice(nullifier_secret);
    preimage.extend_from_slice(&leaf_index.to_le_bytes());
    keccak::hash(&preimage).to_bytes()
}

pub const MERKLE_TREE_HEIGHT: usize = 15;
pub const MERKLE_TREE_CAPACITY: u32 = 1 << MERKLE_TREE_HEIGHT;

// Tree hashing uses Solana's native Poseidon syscall (BN254 / circom
// parameters) so the on-chain root matches the root the Groth16 circuit
// reconstructs. The empty-leaf sentinel is Poseidon([0]) to match the
// off-chain `poseidonZeroHashes` helper in `sdk/src/zk.mjs`.
//
// Native syscall path keeps each hash at ~5k CU and avoids the >4KB
// parameter blob that crashes BPF stack limits when light-poseidon is
// used directly.

use solana_poseidon::{hashv, Endianness, Parameters};

#[inline(never)]
fn poseidon_hash(inputs: &[&[u8]]) -> [u8; 32] {
    hashv(Parameters::Bn254X5, Endianness::BigEndian, inputs)
        .expect("poseidon syscall")
        .to_bytes()
}

pub fn empty_leaf() -> [u8; 32] {
    // Poseidon([0]) — matches `poseidonZeroHashes()` in sdk/src/zk.mjs.
    let zero = [0u8; 32];
    poseidon_hash(&[&zero])
}

/// Two-to-one Poseidon hash for Merkle interior nodes. Both inputs are
/// expected to already be canonical field elements (< p, big-endian).
pub fn hash_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    poseidon_hash(&[left, right])
}

#[inline(never)]
pub fn zero_hash_at_level(level: usize) -> [u8; 32] {
    let mut h = empty_leaf();
    for _ in 0..level {
        h = hash_pair(&h, &h);
    }
    h
}

pub fn compute_zero_hashes() -> [[u8; 32]; MERKLE_TREE_HEIGHT + 1] {
    let mut zeros = [[0u8; 32]; MERKLE_TREE_HEIGHT + 1];
    zeros[0] = empty_leaf();
    for i in 1..=MERKLE_TREE_HEIGHT {
        zeros[i] = hash_pair(&zeros[i - 1], &zeros[i - 1]);
    }
    zeros
}

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

// ---------------------------------------------------------------------------
// Stealth address helpers (ECDH / DKSAP)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ElGamal helpers
// ---------------------------------------------------------------------------

pub fn validate_ciphertext(ct: &[u8; ELGAMAL_CIPHERTEXT_LEN]) -> Result<()> {
    // Both components must be valid compressed Ristretto points
    let c_bytes: [u8; 32] = ct[..32].try_into().unwrap();
    let d_bytes: [u8; 32] = ct[32..].try_into().unwrap();

    for (label, bytes) in [("C", &c_bytes), ("D", &d_bytes)] {
        require!(
            !bytes.iter().all(|&b| b == 0),
            KiriteError::InvalidAmountProof
        );
        let compressed = CompressedRistretto::from_slice(bytes)
            .map_err(|_| error!(KiriteError::InvalidAmountProof))?;
        require!(
            compressed.decompress().is_some(),
            KiriteError::InvalidAmountProof
        );
        let _ = label;
    }
    Ok(())
}

pub fn validate_elgamal_pubkey(pk: &[u8; 32]) -> Result<()> {
    require!(!pk.iter().all(|&b| b == 0), KiriteError::InvalidAmountProof);
    // Must be a valid Ristretto point
    let compressed =
        CompressedRistretto::from_slice(pk).map_err(|_| error!(KiriteError::InvalidAmountProof))?;
    require!(
        compressed.decompress().is_some(),
        KiriteError::InvalidAmountProof
    );
    Ok(())
}

/// Identity ciphertext: (identity_point, identity_point). Encrypts 0 under any key.
pub fn encrypted_zero() -> [u8; ELGAMAL_CIPHERTEXT_LEN] {
    use curve25519_dalek::ristretto::RistrettoPoint;
    use curve25519_dalek::traits::Identity;
    let identity = RistrettoPoint::identity().compress().to_bytes();
    let mut ct = [0u8; ELGAMAL_CIPHERTEXT_LEN];
    ct[..32].copy_from_slice(&identity);
    ct[32..].copy_from_slice(&identity);
    ct
}

// ---------------------------------------------------------------------------
// Withdrawal proof (Merkle path verification)
// ---------------------------------------------------------------------------

pub fn verify_withdrawal_proof(
    nullifier_secret: &[u8; 32],
    blinding_factor: &[u8; 32],
    denomination: u64,
    leaf_index: u32,
    proof: &[[u8; 32]; MERKLE_TREE_HEIGHT],
    root: &[u8; 32],
) -> bool {
    let commitment =
        compute_commitment(nullifier_secret, denomination, blinding_factor, leaf_index);
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
