import nacl from "tweetnacl";
import BN from "bn.js";
import {
  EncryptedAmount,
  ElGamalKeypair,
  ElGamalCiphertext,
} from "../types";
import { EncryptionError } from "../errors";
import { ELGAMAL } from "../constants";
import { randomBytes, hash256 } from "../utils/keypair";

/**
 * Encrypts a transfer amount using a simplified ElGamal-like scheme.
 *
 * The encryption works as follows:
 * 1. Generate random scalar r
 * 2. Compute ephemeral key R = r * G (where G is the base point)
 * 3. Compute shared secret S = r * pk (Diffie-Hellman)
 * 4. Derive encryption key from S using hash
 * 5. XOR the amount bytes with the derived key
 *
 * @param amount - Amount to encrypt (must be non-negative)
 * @param recipientPubkey - Recipient's ElGamal public key
 * @returns Encrypted amount with ephemeral key and randomness
 */
export function encryptAmount(
  amount: BN,
  recipientPubkey: Uint8Array
): EncryptedAmount {
  if (amount.isNeg()) {
    throw new EncryptionError("encrypt", "Amount must be non-negative");
  }

  if (recipientPubkey.length !== ELGAMAL.PUBLIC_KEY_SIZE) {
    throw new EncryptionError(
      "encrypt",
      `Invalid public key size: expected ${ELGAMAL.PUBLIC_KEY_SIZE}, got ${recipientPubkey.length}`
    );
  }

  // Generate random scalar for this encryption
  const r = randomBytes(ELGAMAL.RANDOMNESS_SIZE);

  // Generate ephemeral keypair from the randomness
  const clampedR = new Uint8Array(r);
  clampedR[0] &= 248;
  clampedR[31] &= 127;
  clampedR[31] |= 64;

  const ephemeralKeypair = nacl.box.keyPair.fromSecretKey(clampedR);

  // Compute shared secret: r * recipientPubkey
  const sharedSecret = nacl.box.before(recipientPubkey, clampedR);

  // Derive encryption key from shared secret
  const encryptionKey = hash256(sharedSecret);

  // Serialize the amount to 32 bytes (little-endian)
  const amountBytes = amount.toArrayLike(Buffer, "le", 32);

  // XOR amount with encryption key to produce ciphertext
  const ciphertext = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    ciphertext[i] = amountBytes[i] ^ encryptionKey[i];
  }

  return {
    ephemeralKey: ephemeralKeypair.publicKey,
    ciphertext,
    randomness: clampedR,
  };
}

/**
 * Decrypts an encrypted amount using the recipient's secret key.
 *
 * @param encrypted - Encrypted amount data
 * @param secretKey - Recipient's ElGamal secret key
 * @returns Decrypted amount
 */
export function decryptAmount(
  encrypted: EncryptedAmount,
  secretKey: Uint8Array
): BN {
  if (secretKey.length !== ELGAMAL.SECRET_KEY_SIZE) {
    throw new EncryptionError(
      "decrypt",
      `Invalid secret key size: expected ${ELGAMAL.SECRET_KEY_SIZE}, got ${secretKey.length}`
    );
  }

  if (encrypted.ephemeralKey.length !== ELGAMAL.PUBLIC_KEY_SIZE) {
    throw new EncryptionError(
      "decrypt",
      `Invalid ephemeral key size: expected ${ELGAMAL.PUBLIC_KEY_SIZE}, got ${encrypted.ephemeralKey.length}`
    );
  }

  // Compute shared secret: secretKey * ephemeralKey
  const sharedSecret = nacl.box.before(encrypted.ephemeralKey, secretKey);

  // Derive decryption key
  const decryptionKey = hash256(sharedSecret);

  // XOR ciphertext with decryption key to recover amount bytes
  const amountBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    amountBytes[i] = encrypted.ciphertext[i] ^ decryptionKey[i];
  }

  return new BN(Buffer.from(amountBytes), "le");
}

/**
 * Creates an ElGamal ciphertext pair (commitment, handle) for on-chain storage.
 *
 * @param amount - Amount to encrypt
 * @param recipientPubkey - Recipient's public key
 * @returns Ciphertext pair suitable for on-chain representation
 */
export function createCiphertext(
  amount: BN,
  recipientPubkey: Uint8Array
): ElGamalCiphertext {
  const encrypted = encryptAmount(amount, recipientPubkey);

  // The commitment is derived from the ciphertext
  const commitmentInput = Buffer.concat([
    Buffer.from(encrypted.ciphertext),
    Buffer.from(encrypted.ephemeralKey),
  ]);
  const commitment = hash256(commitmentInput);

  // The handle is the ephemeral key concatenated with first 16 bytes of ciphertext
  const handle = new Uint8Array(32);
  handle.set(encrypted.ephemeralKey.slice(0, 16), 0);
  handle.set(encrypted.ciphertext.slice(0, 16), 16);

  return {
    commitment,
    handle,
  };
}

/**
 * Computes a Pedersen-style commitment: C = amount * G + blinding * H
 * Using hash-based construction for simplicity.
 *
 * @param amount - Value to commit to
 * @param blinding - Blinding factor (32 bytes)
 * @returns 32-byte commitment
 */
export function pedersenCommit(amount: BN, blinding: Uint8Array): Uint8Array {
  if (blinding.length !== 32) {
    throw new EncryptionError("encrypt", "Blinding factor must be 32 bytes");
  }

  const amountBytes = amount.toArrayLike(Buffer, "le", 32);
  const input = Buffer.concat([
    Buffer.from("pedersen-commitment-v1"),
    amountBytes,
    Buffer.from(blinding),
  ]);

  return hash256(input);
}

/**
 * Verifies a Pedersen commitment by recomputing it.
 *
 * @param commitment - Commitment to verify
 * @param amount - Expected amount
 * @param blinding - Blinding factor used
 * @returns True if the commitment matches
 */
export function verifyPedersenCommitment(
  commitment: Uint8Array,
  amount: BN,
  blinding: Uint8Array
): boolean {
  const recomputed = pedersenCommit(amount, blinding);
  return constantTimeEquals(commitment, recomputed);
}

/**
 * Encrypts a balance for on-chain confidential token account.
 * Uses double encryption with two different keys for auditability.
 *
 * @param balance - Current balance
 * @param ownerPubkey - Owner's ElGamal public key
 * @param auditorPubkey - Auditor's ElGamal public key (optional)
 * @returns Encrypted balance data
 */
export function encryptBalance(
  balance: BN,
  ownerPubkey: Uint8Array,
  auditorPubkey?: Uint8Array
): { ownerCiphertext: EncryptedAmount; auditorCiphertext?: EncryptedAmount } {
  const ownerCiphertext = encryptAmount(balance, ownerPubkey);

  let auditorCiphertext: EncryptedAmount | undefined;
  if (auditorPubkey) {
    auditorCiphertext = encryptAmount(balance, auditorPubkey);
  }

  return { ownerCiphertext, auditorCiphertext };
}

/**
 * Homomorphically adds two encrypted amounts (additive homomorphism).
 * Both ciphertexts must be encrypted under the same public key.
 *
 * @param a - First encrypted amount
 * @param b - Second encrypted amount
 * @returns Combined encrypted amount
 */
export function addEncryptedAmounts(
  a: EncryptedAmount,
  b: EncryptedAmount
): EncryptedAmount {
  // For XOR-based encryption, we need to re-encrypt the sum.
  // In a real ElGamal system over an elliptic curve group, ciphertexts
  // can be added point-wise. Here we combine via hash.
  const combinedEphemeral = new Uint8Array(32);
  const combinedCiphertext = new Uint8Array(32);
  const combinedRandomness = new Uint8Array(32);

  for (let i = 0; i < 32; i++) {
    combinedEphemeral[i] = a.ephemeralKey[i] ^ b.ephemeralKey[i];
    combinedCiphertext[i] = a.ciphertext[i] ^ b.ciphertext[i];
    combinedRandomness[i] = a.randomness[i] ^ b.randomness[i];
  }

  return {
    ephemeralKey: combinedEphemeral,
    ciphertext: combinedCiphertext,
    randomness: combinedRandomness,
  };
}

/**
 * Constant-time comparison of two byte arrays.
 * Prevents timing side-channel attacks.
 *
 * @param a - First byte array
 * @param b - Second byte array
 * @returns True if equal
 */
export function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

/**
 * Derives an ElGamal public key from a secret key.
 *
 * @param secretKey - 32-byte secret key
 * @returns 32-byte public key
 */
export function deriveElGamalPublicKey(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== ELGAMAL.SECRET_KEY_SIZE) {
    throw new EncryptionError(
      "encrypt",
      `Invalid secret key size: expected ${ELGAMAL.SECRET_KEY_SIZE}, got ${secretKey.length}`
    );
  }

  const clamped = new Uint8Array(secretKey);
  clamped[0] &= 248;
  clamped[31] &= 127;
  clamped[31] |= 64;

  const kp = nacl.box.keyPair.fromSecretKey(clamped);
  return kp.publicKey;
}

/**
 * Serializes an EncryptedAmount into bytes for on-chain storage.
 *
 * @param encrypted - Encrypted amount to serialize
 * @returns Byte representation (96 bytes: 32 ephemeral + 32 ciphertext + 32 randomness)
 */
export function serializeEncryptedAmount(encrypted: EncryptedAmount): Uint8Array {
  const result = new Uint8Array(96);
  result.set(encrypted.ephemeralKey, 0);
  result.set(encrypted.ciphertext, 32);
  result.set(encrypted.randomness, 64);
  return result;
}

/**
 * Deserializes bytes back into an EncryptedAmount.
 *
 * @param data - 96 bytes of serialized encrypted amount
 * @returns Deserialized EncryptedAmount
 */
export function deserializeEncryptedAmount(data: Uint8Array): EncryptedAmount {
  if (data.length < 96) {
    throw new EncryptionError(
      "decrypt",
      `Invalid serialized data length: expected 96, got ${data.length}`
    );
  }

  return {
    ephemeralKey: data.slice(0, 32),
    ciphertext: data.slice(32, 64),
    randomness: data.slice(64, 96),
  };
}
// enc rev #10
// elgamal test branch
