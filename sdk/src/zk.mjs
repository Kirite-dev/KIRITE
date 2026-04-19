// KIRITE shield-pool ZK helpers (off-chain).
//
// Poseidon-based leaf commitments, Merkle tree reconstruction, and
// Groth16 membership-proof generation. Mirrors the on-chain expectations
// in `programs/kirite/src/utils/zk.rs` and the circuit in
// `circuits/membership.circom`. Anything that touches commitments or
// nullifiers must go through this module so the prover and the on-chain
// verifier stay byte-for-byte compatible.

import { buildPoseidon } from "circomlibjs";
import { groth16 } from "snarkjs";
import { PublicKey } from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tree height matches the on-chain MERKLE_TREE_HEIGHT constant.
export const MERKLE_HEIGHT = 5;
export const MERKLE_CAPACITY = 1 << MERKLE_HEIGHT;

// Domain separators. The "empty leaf" sentinel matches the keccak
// fallback used for the legacy pre-ZK pool layout — the on-chain code
// still uses keccak for tree-internal hashing; the LEAF itself comes
// from Poseidon. We deliberately keep tree hashing on keccak so the
// Solana program can recompute the root in ~1k CU per level instead of
// the ~30k CU Poseidon would cost on-chain.
//
// Actually we changed the leaf hashing to Poseidon for ZK efficiency,
// but tree-internal nodes are STILL keccak on-chain. The verification
// circuit therefore can't accept arbitrary Merkle paths if the tree
// uses different hash functions for leaves vs internal nodes. To keep
// things consistent and simple we use Poseidon for BOTH leaf and tree
// in the circuit; the on-chain Merkle insertion stays on keccak for
// COMPATIBILITY but the ZK proof references a Poseidon-based root that
// the prover reconstructs off-chain. Since `proof_root` is a public
// input and the on-chain code only checks `pool.is_known_root(...)`,
// we need both to agree on a single root — meaning the ON-CHAIN tree
// must also use Poseidon-equivalent hashing.
//
// Bottom line: leaf hashing already uses Poseidon (off-chain).
// Internal nodes need to also use Poseidon for both prover and on-chain
// to agree. That requires changing `hash_pair` and `zero_hash_at_level`
// in `utils/crypto.rs`. We patch that separately.

let _poseidon = null;
let _F = null;

async function poseidon() {
  if (!_poseidon) {
    _poseidon = await buildPoseidon();
    _F = _poseidon.F;
  }
  return _poseidon;
}

// Convert a Poseidon field element to a 32-byte big-endian representation
// (the form the on-chain verifier expects for public inputs).
export function fieldToBE32(fieldEl) {
  const bytes = _F.toObject(fieldEl).toString(16).padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(bytes.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Convert any 32-byte buffer to a BigInt < BN254 prime, suitable as
// circuit input. We treat the bytes as big-endian and reduce mod p.
const BN254_P =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

export function be32ToField(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v % BN254_P;
}

// 32-byte BE → BigInt (without modular reduction; use only when you
// trust the source to already be in field). Useful for nullifier_hash
// re-deserialization.
export function be32ToBigint(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

// Generate a random 32-byte secret reduced into the BN254 field.
export function randomFieldBytes() {
  while (true) {
    const candidate = randomBytes(32);
    const asInt = be32ToBigint(candidate);
    if (asInt < BN254_P && asInt > 0n) return candidate;
  }
}

/**
 * commitment = Poseidon(nullifierSecret, amount, blindingFactor, leafIndex)
 * Returns the commitment as 32 bytes big-endian.
 */
export async function computeCommitment(
  nullifierSecret,
  amount,
  blindingFactor,
  leafIndex,
) {
  const p = await poseidon();
  const nsField = be32ToField(nullifierSecret);
  const bfField = be32ToField(blindingFactor);
  const result = p([nsField, BigInt(amount), bfField, BigInt(leafIndex)]);
  return fieldToBE32(result);
}

/**
 * nullifierHash = Poseidon(nullifierSecret, leafIndex)
 * Returns the nullifier hash as 32 bytes big-endian.
 */
export async function computeNullifierHash(nullifierSecret, leafIndex) {
  const p = await poseidon();
  const nsField = be32ToField(nullifierSecret);
  const result = p([nsField, BigInt(leafIndex)]);
  return fieldToBE32(result);
}

/**
 * Domain-separated 2-to-1 hash matching circomlib's default Poseidon
 * with arity 2. Used to build the in-circuit Merkle tree.
 */
export async function poseidonHashPair(left, right) {
  const p = await poseidon();
  const lField =
    typeof left === "bigint" ? left : be32ToField(left);
  const rField =
    typeof right === "bigint" ? right : be32ToField(right);
  return fieldToBE32(p([lField, rField]));
}

/**
 * Compute the Poseidon-zero-leaf and per-level zero hashes used to
 * pad an empty Merkle tree.
 */
export async function poseidonZeroHashes() {
  const p = await poseidon();
  // Empty leaf: Poseidon of a single zero. Choice is arbitrary as long
  // as it's documented and consistent between prover and on-chain code.
  let h = p([0n]);
  const levels = [fieldToBE32(h)];
  for (let i = 0; i < MERKLE_HEIGHT; i++) {
    h = p([h, h]);
    levels.push(fieldToBE32(h));
  }
  return levels;
}

/**
 * Given the ordered list of leaves and a target leaf index, returns the
 * Merkle root and the path siblings + index bits the circuit needs.
 *
 * `leaves` must be 32-byte buffers in deposit order. Empty slots up to
 * MERKLE_CAPACITY are auto-padded with the zero-leaf hash.
 */
export async function buildMerkleProof(leaves, targetIndex) {
  const p = await poseidon();
  const zeros = await poseidonZeroHashes();

  // Pad leaves to MERKLE_CAPACITY with the empty-leaf sentinel.
  const padded = [];
  for (let i = 0; i < MERKLE_CAPACITY; i++) {
    padded.push(leaves[i] ? Uint8Array.from(leaves[i]) : zeros[0]);
  }

  let level = padded;
  const pathElements = [];
  const pathIndices = [];
  let idx = targetIndex;

  for (let depth = 0; depth < MERKLE_HEIGHT; depth++) {
    const sibling = level[idx ^ 1];
    pathElements.push(sibling);
    pathIndices.push(idx & 1);

    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = be32ToField(level[i]);
      const b = be32ToField(level[i + 1]);
      next.push(fieldToBE32(p([a, b])));
    }
    level = next;
    idx = idx >> 1;
  }

  return {
    root: level[0],
    pathElements,
    pathIndices,
  };
}

/**
 * Hash a Solana account pubkey into a single field-element-shaped 32-byte
 * value. Mirrors `pubkey_to_field` in `utils/zk.rs`: we keccak the
 * 32-byte pubkey, then clear the top three bits so the result is < 2^253
 * and well below the BN254 modulus.
 */
export function pubkeyToField(pubkey) {
  const pk = pubkey instanceof PublicKey ? pubkey.toBytes() : pubkey;
  const h = keccak_256(pk);
  const out = Uint8Array.from(h);
  out[0] &= 0x1f; // top three bits cleared
  return out;
}

export function u64ToBE32(value) {
  const out = new Uint8Array(32);
  const v = BigInt(value);
  for (let i = 31, n = v; i >= 0 && n > 0n; i--, n >>= 8n) {
    out[i] = Number(n & 0xffn);
  }
  return out;
}

/**
 * Generate a Groth16 proof for the membership circuit and pack the
 * outputs into the on-chain transaction layout (proof bytes, public
 * inputs, etc).
 *
 * @param {object} args
 * @param {Uint8Array} args.nullifierSecret   - 32 bytes
 * @param {Uint8Array} args.blindingFactor    - 32 bytes
 * @param {bigint|number|string} args.amount  - pool denomination (lamports)
 * @param {number} args.leafIndex             - this user's leaf
 * @param {Uint8Array[]} args.allLeaves       - every leaf in deposit order
 * @param {PublicKey} args.recipient          - recipient token-account pubkey
 * @param {string} args.wasmPath              - path to membership.wasm
 * @param {string} args.zkeyPath              - path to membership_final.zkey
 *
 * Returns:
 *   {
 *     proof: 256-byte Uint8Array (proof_a||proof_b||proof_c, BE),
 *     publicInputs: { root, nullifierHash, amount, recipientHash } as 32-byte BE,
 *   }
 */
export async function generateMembershipProof({
  nullifierSecret,
  blindingFactor,
  amount,
  leafIndex,
  allLeaves,
  recipient,
  wasmPath,
  zkeyPath,
}) {
  const p = await poseidon();
  const _ = p; // ensure F is initialized
  const commitment = await computeCommitment(
    nullifierSecret,
    amount,
    blindingFactor,
    leafIndex,
  );

  // Sanity: the leaf list should contain our commitment at leafIndex.
  if (allLeaves[leafIndex] === undefined) {
    throw new Error(`leafIndex ${leafIndex} out of bounds in tree`);
  }
  if (
    Buffer.compare(
      Buffer.from(commitment),
      Buffer.from(allLeaves[leafIndex]),
    ) !== 0
  ) {
    throw new Error(
      "computed commitment does not match the leaf at this index — wrong note?",
    );
  }

  const { root, pathElements, pathIndices } = await buildMerkleProof(
    allLeaves,
    leafIndex,
  );
  const nullifierHash = await computeNullifierHash(nullifierSecret, leafIndex);
  const recipientHash = pubkeyToField(recipient);

  const input = {
    root: be32ToField(root).toString(),
    nullifierHash: be32ToField(nullifierHash).toString(),
    amount: BigInt(amount).toString(),
    recipientHash: be32ToField(recipientHash).toString(),
    nullifierSecret: be32ToField(nullifierSecret).toString(),
    blindingFactor: be32ToField(blindingFactor).toString(),
    leafIndex: BigInt(leafIndex).toString(),
    pathElements: pathElements.map((b) => be32ToField(b).toString()),
    pathIndices: pathIndices.map((b) => b.toString()),
  };

  const { proof, publicSignals } = await groth16.fullProve(
    input,
    wasmPath,
    zkeyPath,
  );

  // Pack proof bytes: proof_a (G1, 64) || proof_b (G2, 128) || proof_c (G1, 64)
  const proofBytes = packGroth16Proof(proof);

  return {
    proof: proofBytes,
    publicInputs: {
      root,
      nullifierHash,
      amount: u64ToBE32(amount),
      recipientHash,
    },
    rawPublicSignals: publicSignals,
  };
}

function decToBE32(decStr) {
  let n = BigInt(decStr);
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function packGroth16Proof(proof) {
  // snarkjs proof structure:
  //   pi_a: [x, y, 1]
  //   pi_b: [[x_c1, x_c0], [y_c1, y_c0], [1, 0]]   ← snarkjs uses (c1, c0) order
  //   pi_c: [x, y, 1]
  //
  // alt_bn128 syscall expects each G2 coordinate in the order
  //   x_c0 || x_c1 || y_c0 || y_c1
  // so we swap the c0/c1 halves coming out of snarkjs.

  const a = new Uint8Array(64);
  a.set(decToBE32(proof.pi_a[0]), 0);
  a.set(decToBE32(proof.pi_a[1]), 32);

  const b = new Uint8Array(128);
  b.set(decToBE32(proof.pi_b[0][1]), 0);   // x_c0
  b.set(decToBE32(proof.pi_b[0][0]), 32);  // x_c1
  b.set(decToBE32(proof.pi_b[1][1]), 64);  // y_c0
  b.set(decToBE32(proof.pi_b[1][0]), 96);  // y_c1

  const c = new Uint8Array(64);
  c.set(decToBE32(proof.pi_c[0]), 0);
  c.set(decToBE32(proof.pi_c[1]), 32);

  const out = new Uint8Array(256);
  out.set(a, 0);
  out.set(b, 64);
  out.set(c, 192);
  return out;
}
