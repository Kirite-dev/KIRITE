import { PublicKey, Keypair, Connection, TransactionSignature, Commitment } from "@solana/web3.js";
import BN from "bn.js";

// ─── Core Protocol Types ────────────────────────────────────────────

/** Encrypted amount using ElGamal encryption */
export interface EncryptedAmount {
  /** First component of the ElGamal ciphertext (r * G) */
  ephemeralKey: Uint8Array;
  /** Second component of the ElGamal ciphertext (m * G + r * pk) */
  ciphertext: Uint8Array;
  /** Randomness used in encryption (kept secret) */
  randomness: Uint8Array;
}

/** Decrypted transfer result */
export interface DecryptedTransfer {
  amount: BN;
  sender: PublicKey;
  receiver: PublicKey;
  mint: PublicKey;
  timestamp: number;
  slot: number;
}

/** A point on the elliptic curve represented as bytes */
export interface CurvePoint {
  x: Uint8Array;
  y: Uint8Array;
}

/** Scalar value for curve operations */
export type Scalar = Uint8Array;

// ─── ElGamal Types ──────────────────────────────────────────────────

/** ElGamal keypair for confidential transfers */
export interface ElGamalKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** ElGamal ciphertext pair */
export interface ElGamalCiphertext {
  commitment: Uint8Array;
  handle: Uint8Array;
}

// ─── Zero-Knowledge Proof Types ─────────────────────────────────────

/** Range proof ensuring a value is within [0, 2^64) */
export interface RangeProof {
  proof: Uint8Array;
  commitment: Uint8Array;
}

/** Equality proof showing two ciphertexts encrypt the same value */
export interface EqualityProof {
  proof: Uint8Array;
  challenge: Uint8Array;
  response: Uint8Array;
}

/** Zero-knowledge proof for a confidential transfer */
export interface TransferProof {
  rangeProof: RangeProof;
  equalityProof: EqualityProof;
  /** Proof that the sender has sufficient balance */
  balanceProof: Uint8Array;
}

/** Proof for shield pool deposit */
export interface DepositProof {
  commitment: Uint8Array;
  nullifier: Uint8Array;
  proof: Uint8Array;
}

/** Proof for shield pool withdrawal */
export interface WithdrawProof {
  nullifier: Uint8Array;
  root: Uint8Array;
  proof: Uint8Array;
  recipientHash: Uint8Array;
}

// ─── Shield Pool Types ──────────────────────────────────────────────

/** Shield pool configuration */
export interface ShieldPoolConfig {
  /** Supported deposit denominations */
  denominations: BN[];
  /** Merkle tree depth */
  treeDepth: number;
  /** Pool authority */
  authority: PublicKey;
  /** Token mint */
  mint: PublicKey;
}

/** On-chain shield pool state */
export interface ShieldPoolState {
  poolId: PublicKey;
  authority: PublicKey;
  mint: PublicKey;
  tokenAccount: PublicKey;
  merkleRoot: Uint8Array;
  nextLeafIndex: number;
  treeDepth: number;
  totalDeposits: BN;
  totalWithdrawals: BN;
  denominations: BN[];
  isPaused: boolean;
  bump: number;
}

/** Deposit note kept by the user for later withdrawal */
export interface DepositNote {
  commitment: Uint8Array;
  nullifier: Uint8Array;
  secret: Uint8Array;
  amount: BN;
  leafIndex: number;
  timestamp: number;
  poolId: string;
}

/** Merkle path for proving inclusion */
export interface MerklePath {
  siblings: Uint8Array[];
  pathIndices: number[];
}

/** Node in the Merkle tree */
export interface MerkleNode {
  hash: Uint8Array;
  index: number;
  level: number;
}

// ─── Stealth Address Types ──────────────────────────────────────────

/** Stealth meta-address published by the recipient */
export interface StealthMetaAddress {
  spendingKey: Uint8Array;
  viewingKey: Uint8Array;
}

/** Generated stealth address for a one-time payment */
export interface StealthAddress {
  address: PublicKey;
  ephemeralPubkey: Uint8Array;
  viewTag: number;
}

/** Result of scanning for incoming stealth payments */
export interface StealthPayment {
  address: PublicKey;
  ephemeralPubkey: Uint8Array;
  amount: BN;
  mint: PublicKey;
  timestamp: number;
  slot: number;
  txSignature: string;
}

/** On-chain stealth registry entry */
export interface StealthRegistryEntry {
  owner: PublicKey;
  metaAddress: StealthMetaAddress;
  label: string;
  createdAt: number;
}

// ─── Client Configuration ───────────────────────────────────────────

/** Configuration for KiriteClient */
export interface KiriteClientConfig {
  /** Solana RPC endpoint URL */
  endpoint: string;
  /** Commitment level for queries */
  commitment?: Commitment;
  /** Wallet keypair for signing */
  wallet?: Keypair;
  /** KIRITE program ID override */
  programId?: PublicKey;
  /** Transaction confirmation timeout in ms */
  confirmTimeout?: number;
  /** Number of retries for failed transactions */
  maxRetries?: number;
  /** Skip preflight checks */
  skipPreflight?: boolean;
}

/** Transaction options */
export interface TransactionOptions {
  /** Skip preflight simulation */
  skipPreflight?: boolean;
  /** Max retries on failure */
  maxRetries?: number;
  /** Confirmation commitment */
  commitment?: Commitment;
  /** Pre-flight commitment */
  preflightCommitment?: Commitment;
}

/** Retry configuration */
export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
}

// ─── Confidential Transfer Types ────────────────────────────────────

/** Parameters for a confidential transfer */
export interface ConfidentialTransferParams {
  /** Recipient public key */
  recipient: PublicKey;
  /** Transfer amount in base units */
  amount: BN;
  /** Token mint */
  mint: PublicKey;
  /** Recipient's ElGamal public key */
  recipientElGamalPubkey: Uint8Array;
  /** Optional memo */
  memo?: string;
}

/** Result of a confidential transfer */
export interface ConfidentialTransferResult {
  signature: TransactionSignature;
  encryptedAmount: EncryptedAmount;
  proof: TransferProof;
  slot: number;
}

// ─── Shield Pool Operation Types ────────────────────────────────────

/** Parameters for depositing into a shield pool */
export interface DepositParams {
  /** Pool to deposit into */
  poolId: PublicKey;
  /** Amount to deposit */
  amount: BN;
  /** Token mint */
  mint: PublicKey;
}

/** Result of a deposit */
export interface DepositResult {
  signature: TransactionSignature;
  note: DepositNote;
  slot: number;
}

/** Parameters for withdrawing from a shield pool */
export interface WithdrawParams {
  /** Pool to withdraw from */
  poolId: PublicKey;
  /** Deposit note to use */
  note: DepositNote;
  /** Recipient address */
  recipient: PublicKey;
  /** Relayer fee (optional) */
  relayerFee?: BN;
}

/** Result of a withdrawal */
export interface WithdrawResult {
  signature: TransactionSignature;
  amount: BN;
  recipient: PublicKey;
  slot: number;
}

// ─── Stealth Operation Types ────────────────────────────────────────

/** Parameters for generating a stealth address */
export interface GenerateStealthParams {
  /** Recipient's stealth meta-address */
  metaAddress: StealthMetaAddress;
}

/** Parameters for scanning stealth payments */
export interface ScanStealthParams {
  /** Viewing key to scan with */
  viewingKey: Uint8Array;
  /** Spending key for address derivation */
  spendingKey: Uint8Array;
  /** Start scanning from this slot */
  fromSlot?: number;
  /** End scanning at this slot (default: latest) */
  toSlot?: number;
}

// ─── Event Types ────────────────────────────────────────────────────

export interface ConfidentialTransferEvent {
  sender: PublicKey;
  recipient: PublicKey;
  encryptedAmount: EncryptedAmount;
  mint: PublicKey;
  slot: number;
  timestamp: number;
  signature: string;
}

export interface ShieldDepositEvent {
  depositor: PublicKey;
  poolId: PublicKey;
  commitment: Uint8Array;
  leafIndex: number;
  amount: BN;
  slot: number;
  timestamp: number;
  signature: string;
}

export interface ShieldWithdrawEvent {
  recipient: PublicKey;
  poolId: PublicKey;
  nullifier: Uint8Array;
  amount: BN;
  slot: number;
  timestamp: number;
  signature: string;
}

export interface StealthAnnouncementEvent {
  ephemeralPubkey: Uint8Array;
  stealthAddress: PublicKey;
  viewTag: number;
  slot: number;
  timestamp: number;
  signature: string;
}
// type rev #6
