import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { RetryConfig } from "./types";

/** KIRITE program ID on Solana mainnet */
export const KIRITE_PROGRAM_ID = new PublicKey(
  "KRTEpRYCuGR4N7EbMqQBNHGueaLqVMR26tV7K5aCSBs"
);

/** KIRITE program ID on devnet */
export const KIRITE_DEVNET_PROGRAM_ID = new PublicKey(
  "KRTEdv1YpRCuGR4N7EbMqQBNHGueaLqVMR26tGH8d3x"
);

/** Seeds for PDA derivation */
export const SEEDS = {
  POOL_STATE: Buffer.from("pool_state"),
  POOL_TOKEN: Buffer.from("pool_token"),
  POOL_AUTHORITY: Buffer.from("pool_authority"),
  MERKLE_TREE: Buffer.from("merkle_tree"),
  NULLIFIER: Buffer.from("nullifier"),
  STEALTH_REGISTRY: Buffer.from("stealth_registry"),
  STEALTH_ANNOUNCEMENT: Buffer.from("stealth_announcement"),
  CONFIDENTIAL_ACCOUNT: Buffer.from("confidential_account"),
  ENCRYPTED_BALANCE: Buffer.from("encrypted_balance"),
} as const;

/** Default Merkle tree depth for shield pools */
export const DEFAULT_TREE_DEPTH = 20;

/** Maximum Merkle tree depth */
export const MAX_TREE_DEPTH = 32;

/** Number of leaves in default tree: 2^20 = 1,048,576 */
export const DEFAULT_TREE_CAPACITY = 2 ** DEFAULT_TREE_DEPTH;

/** Default denominations for shield pools (in lamports / base units) */
export const DEFAULT_DENOMINATIONS = [
  new BN(100_000_000),      // 0.1 SOL
  new BN(1_000_000_000),    // 1 SOL
  new BN(10_000_000_000),   // 10 SOL
  new BN(100_000_000_000),  // 100 SOL
];

/** ElGamal encryption constants */
export const ELGAMAL = {
  /** Size of an ElGamal public key in bytes */
  PUBLIC_KEY_SIZE: 32,
  /** Size of an ElGamal secret key in bytes */
  SECRET_KEY_SIZE: 32,
  /** Size of a ciphertext component */
  CIPHERTEXT_SIZE: 32,
  /** Size of randomness used in encryption */
  RANDOMNESS_SIZE: 32,
} as const;

/** Zero-knowledge proof sizes */
export const PROOF_SIZES = {
  RANGE_PROOF: 672,
  EQUALITY_PROOF: 192,
  BALANCE_PROOF: 128,
  DEPOSIT_PROOF: 256,
  WITHDRAW_PROOF: 256,
} as const;

/** Stealth address constants */
export const STEALTH = {
  /** View tag size in bytes */
  VIEW_TAG_SIZE: 1,
  /** Ephemeral key size */
  EPHEMERAL_KEY_SIZE: 32,
  /** Meta-address total size */
  META_ADDRESS_SIZE: 64,
} as const;

/** Default RPC endpoints */
export const RPC_ENDPOINTS = {
  MAINNET: "https://api.mainnet-beta.solana.com",
  DEVNET: "https://api.devnet.solana.com",
  TESTNET: "https://api.testnet.solana.com",
  LOCALNET: "http://localhost:8899",
} as const;

/** Default retry configuration */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 500,
  maxDelay: 5000,
  backoffMultiplier: 2,
};

/** Default transaction confirmation timeout in milliseconds */
export const DEFAULT_CONFIRM_TIMEOUT = 30_000;

/** Maximum compute units for KIRITE transactions */
export const COMPUTE_BUDGET = {
  CONFIDENTIAL_TRANSFER: 400_000,
  SHIELD_DEPOSIT: 300_000,
  SHIELD_WITHDRAW: 500_000,
  STEALTH_SEND: 200_000,
  REGISTRY_UPDATE: 100_000,
} as const;

/** Hash used as the zero leaf in Merkle tree */
export const ZERO_VALUE = Buffer.alloc(32, 0);

/** Field modulus for BN254 curve (used in proofs) */
export const BN254_FIELD_MODULUS = new BN(
  "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
  16
);

/** Generator point G for curve operations (compressed, Ed25519) */
export const GENERATOR_POINT = Buffer.from(
  "5866666666666666666666666666666666666666666666666666666666666666",
  "hex"
);

/** Account discriminator size for Anchor accounts */
export const DISCRIMINATOR_SIZE = 8;

/** Maximum memo length in bytes */
export const MAX_MEMO_LENGTH = 256;
