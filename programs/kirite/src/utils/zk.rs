// Groth16 verifier for the membership-proof circuit.
//
// The circuit (`circuits/membership.circom`) proves knowledge of
// (nullifier_secret, blinding_factor, leaf_index, merkle_path) such that
// the corresponding leaf commitment is included in a known Merkle root,
// without revealing any of those secrets. The on-chain verifier consumes
// only the proof + four public inputs and the alt_bn128 syscall does the
// pairing math.
//
// Public inputs (order matches the circuit's `main` declaration):
//   0. root           — Merkle root the leaf is proven to belong to
//   1. nullifier_hash — Poseidon(ns, leaf_index); spent-marker on-chain
//   2. amount         — pool denomination, must equal `pool.denomination`
//   3. recipient_hash — bound to the recipient account so the proof
//                       cannot be replayed to a different address
//
// Layout of the on-chain proof bytes (256 bytes total):
//   [0..64]    proof_a  (G1, BN254, big-endian uncompressed: x || y)
//   [64..192]  proof_b  (G2, BN254, big-endian: x_c0 || x_c1 || y_c0 || y_c1)
//   [192..256] proof_c  (G1)
//
// Each public input is a 32-byte big-endian field element. Anything ≥ p
// (the BN254 base-field modulus) is rejected — clients must reduce before
// submitting. We do not auto-reduce on-chain because doing so silently
// would let two distinct preimages share a verified statement.

use anchor_lang::prelude::*;
use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};

use crate::errors::KiriteError;
use crate::utils::membership_vk::membership_vk;

pub const PROOF_LEN: usize = 256;
pub const PUBLIC_INPUT_LEN: usize = 32;
pub const N_PUBLIC_INPUTS: usize = membership_vk::N_PUBLIC;

// BN254 base-field modulus, big-endian. Used both as a sanity gate on
// the public inputs (they must be < p) and as the modulus for negating
// proof_a's y-coordinate.
/// BN254 base-field modulus (big-endian). Public so other instructions
/// (e.g. deposit's commitment guard) can reuse the same constant.
pub const BN254_FIELD_MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
];

const BN254_P: [u8; 32] = BN254_FIELD_MODULUS;

// `vk_gamme_g2` is spelled with the same typo upstream in
// groth16-solana 0.2.x. Don't fix it here; mirror the upstream field
// name so the binding compiles.
const VK: Groth16Verifyingkey = Groth16Verifyingkey {
    nr_pubinputs: membership_vk::N_PUBLIC,
    vk_alpha_g1: membership_vk::ALPHA_G1,
    vk_beta_g2: membership_vk::BETA_G2,
    vk_gamme_g2: membership_vk::GAMMA_G2,
    vk_delta_g2: membership_vk::DELTA_G2,
    vk_ic: &membership_vk::IC,
};

/// Negate the y-coordinate of a G1 point in big-endian encoding.
/// Groth16 verification expects -A in the pairing; client tooling
/// generally produces +A, so we negate on-chain to keep the wire
/// format simple.
fn negate_g1_y(g1: &[u8; 64]) -> [u8; 64] {
    let mut out = *g1;
    let mut borrow: i16 = 0;
    for i in (0..32).rev() {
        let p_byte = BN254_P[i] as i16;
        let y_byte = g1[32 + i] as i16;
        let mut diff = p_byte - y_byte - borrow;
        if diff < 0 {
            diff += 256;
            borrow = 1;
        } else {
            borrow = 0;
        }
        out[32 + i] = diff as u8;
    }
    out
}

/// True iff the 32-byte big-endian value is strictly less than the
/// BN254 field modulus. Use this for any caller-supplied bytes that
/// will be hashed or treated as a field element on-chain.
pub fn is_canonical_field_element(bytes: &[u8; 32]) -> bool {
    lt_be32(bytes, &BN254_FIELD_MODULUS)
}

/// Compare two 32-byte big-endian numbers. Returns true if lhs < rhs.
fn lt_be32(lhs: &[u8; 32], rhs: &[u8; 32]) -> bool {
    for i in 0..32 {
        if lhs[i] < rhs[i] {
            return true;
        }
        if lhs[i] > rhs[i] {
            return false;
        }
    }
    false // equal — not strictly less
}

/// Verify a Groth16 proof for the membership circuit.
///
/// `proof` must be exactly PROOF_LEN bytes laid out as described above.
/// `public_inputs` must contain N_PUBLIC_INPUTS elements in the order
/// declared by the circuit (root, nullifier_hash, amount, recipient_hash).
pub fn verify_membership_proof(
    proof: &[u8],
    public_inputs: &[[u8; PUBLIC_INPUT_LEN]; N_PUBLIC_INPUTS],
) -> Result<()> {
    require!(proof.len() == PROOF_LEN, KiriteError::InvalidAmountProof);

    // Each public input must be a canonical field element (< p).
    for input in public_inputs.iter() {
        require!(lt_be32(input, &BN254_P), KiriteError::InvalidAmountProof);
    }

    let proof_a_raw: [u8; 64] = proof[0..64]
        .try_into()
        .map_err(|_| error!(KiriteError::InvalidAmountProof))?;
    let proof_b: [u8; 128] = proof[64..192]
        .try_into()
        .map_err(|_| error!(KiriteError::InvalidAmountProof))?;
    let proof_c: [u8; 64] = proof[192..256]
        .try_into()
        .map_err(|_| error!(KiriteError::InvalidAmountProof))?;

    // groth16-solana expects proof_a with y already negated.
    let proof_a = negate_g1_y(&proof_a_raw);

    let mut verifier = Groth16Verifier::new(&proof_a, &proof_b, &proof_c, public_inputs, &VK)
        .map_err(|_| error!(KiriteError::InvalidAmountProof))?;

    verifier
        .verify()
        .map_err(|_| error!(KiriteError::InvalidAmountProof))?;

    Ok(())
}

/// Pack a u64 as a 32-byte big-endian field element. Used to encode the
/// pool's denomination into the public-input vector for the verifier.
pub fn u64_to_field_be(value: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&value.to_be_bytes());
    out
}

/// Hash a Solana account pubkey into a single 32-byte field element by
/// taking SHA-256 and clamping the high bits so the result is < p. We
/// zero out the top three bits, which guarantees the value is well below
/// the BN254 modulus while still leaving 253 bits of preimage entropy.
/// Both the prover (off-chain) and verifier (on-chain) apply the same
/// transform so the binding holds.
pub fn pubkey_to_field(pubkey: &Pubkey) -> [u8; 32] {
    use solana_program::keccak;
    // SHA-256 would be marginally cheaper but we already pull keccak in
    // from solana-program for the legacy path; using one hash family
    // keeps the binary small.
    let h = keccak::hash(&pubkey.to_bytes()).to_bytes();
    let mut out = h;
    out[0] &= 0x1f; // clear top three bits → result is always < 2^253 < p
    out
}
