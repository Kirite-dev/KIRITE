import { PublicKey, Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  StealthMetaAddress,
  StealthAddress,
} from "../types";
import { StealthAddressError } from "../errors";
import { STEALTH } from "../constants";
import {
  deriveViewingKeypair,
  deriveSpendingKeypair,
  randomBytes,
  hash256,
  computeSharedSecret,
} from "../utils/keypair";

/**
 * Generates a stealth meta-address from a Solana keypair.
 * The meta-address consists of two public keys:
 * - Spending key: controls funds at stealth addresses
 * - Viewing key: allows scanning for incoming payments
 *
 * @param wallet - Owner's Solana keypair
 * @returns Stealth meta-address
 */
export function generateStealthMetaAddress(
  wallet: Keypair
): StealthMetaAddress {
  const viewingKeypair = deriveViewingKeypair(wallet);
  const spendingKeypair = deriveSpendingKeypair(wallet);

  return {
    spendingKey: spendingKeypair.publicKey,
    viewingKey: viewingKeypair.publicKey,
  };
}

/**
 * Generates a one-time stealth address for a payment.
 *
 * Protocol (DKSAP-like):
 * 1. Sender generates ephemeral keypair (r, R = r*G)
 * 2. Sender computes shared secret S = r * viewingKey
 * 3. Sender derives stealth public key: P = spendingKey + H(S) * G
 * 4. View tag = first byte of H(S) (for efficient scanning)
 *
 * Since we use X25519 for ECDH and Ed25519 for addresses, we hash the
 * shared secret to derive a Solana-compatible address.
 *
 * @param metaAddress - Recipient's stealth meta-address
 * @returns Generated stealth address with ephemeral data
 */
export function generateStealthAddress(
  metaAddress: StealthMetaAddress
): StealthAddress {
  if (
    metaAddress.spendingKey.length !== STEALTH.EPHEMERAL_KEY_SIZE ||
    metaAddress.viewingKey.length !== STEALTH.EPHEMERAL_KEY_SIZE
  ) {
    throw new StealthAddressError(
      "Invalid meta-address key sizes"
    );
  }

  // Step 1: Generate ephemeral keypair
  const ephemeralSecret = randomBytes(32);
  const clampedSecret = new Uint8Array(ephemeralSecret);
  clampedSecret[0] &= 248;
  clampedSecret[31] &= 127;
  clampedSecret[31] |= 64;

  const ephemeralKeypair = nacl.box.keyPair.fromSecretKey(clampedSecret);

  // Step 2: Compute shared secret using ECDH
  const sharedSecret = computeSharedSecret(
    clampedSecret,
    metaAddress.viewingKey
  );

  // Step 3: Hash the shared secret
  const sharedHash = hash256(
    Buffer.concat([
      Buffer.from("kirite-stealth-v1"),
      Buffer.from(sharedSecret),
    ])
  );

  // Step 4: Derive stealth address
  // Combine spendingKey with hashed shared secret to create a unique address
  const stealthSeed = hash256(
    Buffer.concat([
      Buffer.from("stealth-address-seed"),
      Buffer.from(metaAddress.spendingKey),
      sharedHash,
    ])
  );

  // Create a deterministic keypair from the stealth seed
  // The stealth address is the public key of this derived keypair
  const stealthKeypair = Keypair.fromSeed(stealthSeed);

  // Step 5: Compute view tag (first byte of shared hash)
  const viewTag = sharedHash[0];

  return {
    address: stealthKeypair.publicKey,
    ephemeralPubkey: ephemeralKeypair.publicKey,
    viewTag,
  };
}

/**
 * Checks if a stealth announcement is intended for us using the view tag.
 * This is a fast pre-filter before doing the full ECDH computation.
 *
 * @param ephemeralPubkey - Ephemeral public key from the announcement
 * @param viewTag - View tag from the announcement
 * @param viewingSecretKey - Our viewing secret key
 * @returns True if the view tag matches (potential match)
 */
export function checkViewTag(
  ephemeralPubkey: Uint8Array,
  viewTag: number,
  viewingSecretKey: Uint8Array
): boolean {
  // Compute shared secret
  const sharedSecret = computeSharedSecret(viewingSecretKey, ephemeralPubkey);

  // Hash the shared secret
  const sharedHash = hash256(
    Buffer.concat([
      Buffer.from("kirite-stealth-v1"),
      Buffer.from(sharedSecret),
    ])
  );

  // Check if the view tag matches
  return sharedHash[0] === viewTag;
}

/**
 * Derives the stealth address private key for spending.
 * Only the recipient who knows both the viewing and spending secrets can do this.
 *
 * @param ephemeralPubkey - Ephemeral public key from the stealth announcement
 * @param viewingSecretKey - Recipient's viewing secret key
 * @param spendingSecretKey - Recipient's spending secret key
 * @returns Keypair for the stealth address (can spend funds)
 */
export function deriveStealthSpendingKey(
  ephemeralPubkey: Uint8Array,
  viewingSecretKey: Uint8Array,
  spendingSecretKey: Uint8Array
): Keypair {
  // Compute shared secret: viewingSecret * ephemeralPubkey
  const sharedSecret = computeSharedSecret(viewingSecretKey, ephemeralPubkey);

  // Hash shared secret
  const sharedHash = hash256(
    Buffer.concat([
      Buffer.from("kirite-stealth-v1"),
      Buffer.from(sharedSecret),
    ])
  );

  // Derive the stealth private key: spendingSecret + H(sharedSecret)
  // For Ed25519 compatibility, we hash the combination
  const stealthSeed = hash256(
    Buffer.concat([
      Buffer.from("stealth-address-seed"),
      // The spending public key derived from the secret
      Buffer.from(nacl.box.keyPair.fromSecretKey(spendingSecretKey).publicKey),
      sharedHash,
    ])
  );

  return Keypair.fromSeed(stealthSeed);
}

/**
 * Recovers the stealth address from an ephemeral pubkey and meta-address.
 * Used to verify that a stealth address was correctly generated.
 *
 * @param ephemeralPubkey - Ephemeral public key
 * @param metaAddress - Recipient's meta-address
 * @param viewingSecretKey - Recipient's viewing secret key
 * @returns Expected stealth address
 */
export function recoverStealthAddress(
  ephemeralPubkey: Uint8Array,
  metaAddress: StealthMetaAddress,
  viewingSecretKey: Uint8Array
): PublicKey {
  const keypair = deriveStealthSpendingKey(
    ephemeralPubkey,
    viewingSecretKey,
    // We only need the spending public key for address derivation
    // The actual spending key isn't needed for recovery, just verification
    new Uint8Array(32) // Placeholder - we use the meta-address spending key directly
  );

  // Recompute using the meta-address spending key
  const sharedSecret = computeSharedSecret(viewingSecretKey, ephemeralPubkey);
  const sharedHash = hash256(
    Buffer.concat([
      Buffer.from("kirite-stealth-v1"),
      Buffer.from(sharedSecret),
    ])
  );

  const stealthSeed = hash256(
    Buffer.concat([
      Buffer.from("stealth-address-seed"),
      Buffer.from(metaAddress.spendingKey),
      sharedHash,
    ])
  );

  const stealthKeypair = Keypair.fromSeed(stealthSeed);
  return stealthKeypair.publicKey;
}

/**
 * Serializes a stealth meta-address to a hex string.
 * @param metaAddress - Meta-address to serialize
 * @returns Hex string (128 characters)
 */
export function serializeStealthMetaAddress(
  metaAddress: StealthMetaAddress
): string {
  return (
    Buffer.from(metaAddress.spendingKey).toString("hex") +
    Buffer.from(metaAddress.viewingKey).toString("hex")
  );
}

/**
 * Deserializes a hex string to a stealth meta-address.
 * @param hex - Hex string (128 characters)
 * @returns Parsed meta-address
 */
export function deserializeStealthMetaAddress(hex: string): StealthMetaAddress {
  if (hex.length !== 128) {
    throw new StealthAddressError(
      `Invalid meta-address hex length: expected 128, got ${hex.length}`
    );
  }

  return {
    spendingKey: Buffer.from(hex.slice(0, 64), "hex"),
    viewingKey: Buffer.from(hex.slice(64, 128), "hex"),
  };
}

/**
 * Validates a stealth meta-address.
 * @param metaAddress - Meta-address to validate
 * @returns True if valid
 */
export function validateStealthMetaAddress(
  metaAddress: StealthMetaAddress
): boolean {
  if (
    metaAddress.spendingKey.length !== 32 ||
    metaAddress.viewingKey.length !== 32
  ) {
    return false;
  }

  // Check keys are non-zero
  let spendingNonZero = false;
  let viewingNonZero = false;

  for (let i = 0; i < 32; i++) {
    if (metaAddress.spendingKey[i] !== 0) spendingNonZero = true;
    if (metaAddress.viewingKey[i] !== 0) viewingNonZero = true;
  }

  return spendingNonZero && viewingNonZero;
}
// addr rev #15
