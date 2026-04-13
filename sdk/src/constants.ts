import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { RetryConfig } from "./types";

export const KIRITE_PROGRAM_ID = new PublicKey(
  "KRTEpRYCuGR4N7EbMqQBNHGueaLqVMR26tV7K5aCSBs"
);

export const KIRITE_DEVNET_PROGRAM_ID = new PublicKey(
  "KRTEdv1YpRCuGR4N7EbMqQBNHGueaLqVMR26tGH8d3x"
);

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

export const DEFAULT_TREE_DEPTH = 20;
export const MAX_TREE_DEPTH = 32;
export const DEFAULT_TREE_CAPACITY = 2 ** DEFAULT_TREE_DEPTH;

export const DEFAULT_DENOMINATIONS = [
  new BN(100_000_000),      // 0.1 SOL
  new BN(1_000_000_000),    // 1 SOL
  new BN(10_000_000_000),   // 10 SOL
  new BN(100_000_000_000),  // 100 SOL
];

export const ELGAMAL = {
  PUBLIC_KEY_SIZE: 32,
  SECRET_KEY_SIZE: 32,
  CIPHERTEXT_SIZE: 32,
  RANDOMNESS_SIZE: 32,
} as const;

export const PROOF_SIZES = {
  RANGE_PROOF: 672,
  EQUALITY_PROOF: 192,
  BALANCE_PROOF: 128,
  DEPOSIT_PROOF: 256,
  WITHDRAW_PROOF: 256,
} as const;

export const STEALTH = {
  VIEW_TAG_SIZE: 1,
  EPHEMERAL_KEY_SIZE: 32,
  META_ADDRESS_SIZE: 64,
} as const;

export const RPC_ENDPOINTS = {
  MAINNET: "https://api.mainnet-beta.solana.com",
  DEVNET: "https://api.devnet.solana.com",
  TESTNET: "https://api.testnet.solana.com",
  LOCALNET: "http://localhost:8899",
} as const;

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 500,
  maxDelay: 5000,
  backoffMultiplier: 2,
};

export const DEFAULT_CONFIRM_TIMEOUT = 30_000;

export const DEFAULT_CONFIRM_TIMEOUT = 30_000;

export const COMPUTE_BUDGET = {
  CONFIDENTIAL_TRANSFER: 400_000,
  SHIELD_DEPOSIT: 300_000,
  SHIELD_WITHDRAW: 500_000,
  STEALTH_SEND: 200_000,
  REGISTRY_UPDATE: 100_000,
} as const;

export const ZERO_VALUE = Buffer.alloc(32, 0);

/** BN254 field modulus for proof arithmetic */
export const BN254_FIELD_MODULUS = new BN(
  "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
  16
);

/** Compressed Ed25519 generator */
export const GENERATOR_POINT = Buffer.from(
  "5866666666666666666666666666666666666666666666666666666666666666",
  "hex"
);

export const DISCRIMINATOR_SIZE = 8;
export const MAX_MEMO_LENGTH = 256;
// const rev #7
