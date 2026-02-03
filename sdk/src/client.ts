import {
  Connection,
  Keypair,
  PublicKey,
  TransactionSignature,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  KiriteClientConfig,
  ConfidentialTransferParams,
  ConfidentialTransferResult,
  DepositParams,
  DepositResult,
  WithdrawParams,
  WithdrawResult,
  DepositNote,
  StealthMetaAddress,
  StealthAddress,
  StealthPayment,
  ShieldPoolState,
  StealthRegistryEntry,
  DecryptedTransfer,
  ElGamalKeypair,
  TransactionOptions,
  ScanStealthParams,
} from "./types";
import {
  WalletNotConnectedError,
  ConnectionError,
} from "./errors";
import {
  KIRITE_PROGRAM_ID,
  DEFAULT_CONFIRM_TIMEOUT,
  DEFAULT_RETRY_CONFIG,
} from "./constants";
import {
  createConnection,
  validateConnection,
  resolveEndpoint,
} from "./utils/connection";
import {
  deriveElGamalKeypair,
  deriveViewingKeypair,
  deriveSpendingKeypair,
} from "./utils/keypair";
import {
  executeConfidentialTransfer,
  decryptIncomingTransfers,
  getConfidentialBalance,
  buildInitConfidentialAccountInstruction,
} from "./confidential/transfer";
import { encryptAmount, decryptAmount } from "./confidential/encryption";
import {
  executeDeposit,
  serializeDepositNote,
  deserializeDepositNote,
} from "./shield-pool/deposit";
import { executeWithdraw, estimateRelayerFee } from "./shield-pool/withdraw";
import {
  fetchPoolState,
  fetchPoolsByMint,
  fetchAllPools,
  isNullifierSpent,
} from "./shield-pool/pool-state";
import {
  generateStealthMetaAddress,
  generateStealthAddress,
  deriveStealthSpendingKey,
} from "./stealth/address";
import {
  scanStealthPayments,
  scanStealthPaymentsFromLogs,
} from "./stealth/scan";
import {
  registerStealthMetaAddress,
  publishStealthAnnouncement,
  lookupStealthMetaAddress,
  fetchRegistryEntry,
  fetchAllRegistryEntries,
} from "./stealth/registry";
import {
  buildTransaction,
  sendAndConfirmTransaction,
} from "./utils/transaction";

/**
 * Main entry point for the KIRITE privacy protocol SDK.
 *
 * Provides a unified interface for:
 * - Confidential transfers (encrypted amounts)
 * - Shield pool operations (deposit/withdraw for unlinkability)
 * - Stealth addresses (one-time recipient addresses)
 *
 * @example
 * ```typescript
 * const client = new KiriteClient({
 *   endpoint: "https://api.devnet.solana.com",
 *   wallet: myKeypair,
 * });
 *
 * await client.connect();
 *
 * // Confidential transfer
 * const result = await client.confidentialTransfer({
 *   recipient: recipientPubkey,
 *   amount: new BN(1_000_000),
 *   mint: usdcMint,
 *   recipientElGamalPubkey: recipientElGamal,
 * });
 * ```
 */
export class KiriteClient {
  private connection: Connection;
  private wallet: Keypair | null;
  private programId: PublicKey;
  private confirmTimeout: number;
  private defaultOptions: TransactionOptions;
  private elGamalKeypair: ElGamalKeypair | null = null;
  private isConnected: boolean = false;

  constructor(config: KiriteClientConfig) {
    const endpoint = config.endpoint.startsWith("http")
      ? config.endpoint
      : resolveEndpoint(config.endpoint);

    this.connection = createConnection(
      endpoint,
      config.commitment || "confirmed"
    );
    this.wallet = config.wallet || null;
    this.programId = config.programId || KIRITE_PROGRAM_ID;
    this.confirmTimeout = config.confirmTimeout || DEFAULT_CONFIRM_TIMEOUT;
    this.defaultOptions = {
      skipPreflight: config.skipPreflight || false,
      maxRetries: config.maxRetries || DEFAULT_RETRY_CONFIG.maxRetries,
      commitment: config.commitment || "confirmed",
    };

    if (this.wallet) {
      this.elGamalKeypair = deriveElGamalKeypair(this.wallet);
    }
  }

  // ─── Connection Management ─────────────────────────────────────

  /**
   * Validates the RPC connection.
   * @throws ConnectionError if the connection is unhealthy
   */
  async connect(): Promise<void> {
    await validateConnection(this.connection);
    this.isConnected = true;
  }

  /**
   * Returns the underlying Solana connection.
   */
  getConnection(): Connection {
    return this.connection;
  }

  /**
   * Returns the wallet public key.
   * @throws WalletNotConnectedError if no wallet is set
   */
  getWalletPublicKey(): PublicKey {
    if (!this.wallet) {
      throw new WalletNotConnectedError();
    }
    return this.wallet.publicKey;
  }

  /**
   * Sets or replaces the wallet keypair.
   * @param wallet - New wallet keypair
   */
  setWallet(wallet: Keypair): void {
    this.wallet = wallet;
    this.elGamalKeypair = deriveElGamalKeypair(wallet);
  }

  /**
   * Returns the ElGamal public key for this wallet.
   * @throws WalletNotConnectedError if no wallet is set
   */
  getElGamalPublicKey(): Uint8Array {
    if (!this.elGamalKeypair) {
      throw new WalletNotConnectedError();
    }
    return this.elGamalKeypair.publicKey;
  }

  /**
   * Returns the current program ID.
   */
  getProgramId(): PublicKey {
    return this.programId;
  }

  /**
   * Checks if the client is connected and has a wallet.
   */
  isReady(): boolean {
    return this.isConnected && this.wallet !== null;
  }

  // ─── Confidential Transfers ────────────────────────────────────

  /**
   * Initializes a confidential token account for the connected wallet.
   *
   * @param mint - Token mint
   * @param options - Transaction options
   * @returns Transaction signature
   */
  async initConfidentialAccount(
    mint: PublicKey,
    options?: TransactionOptions
  ): Promise<TransactionSignature> {
    this.requireWallet();

    const ix = buildInitConfidentialAccountInstruction(
      this.wallet!.publicKey,
      mint,
      this.elGamalKeypair!.publicKey,
      this.programId
    );

    const tx = await buildTransaction(
      this.connection,
      this.wallet!.publicKey,
      [ix]
    );

    return sendAndConfirmTransaction(
      this.connection,
      tx,
      [this.wallet!],
      options || this.defaultOptions
    );
  }

  /**
   * Executes a confidential transfer with encrypted amounts.
   *
   * @param params - Transfer parameters
   * @param options - Transaction options
   * @returns Transfer result
   */
  async confidentialTransfer(
    params: ConfidentialTransferParams,
    options?: TransactionOptions
  ): Promise<ConfidentialTransferResult> {
    this.requireWallet();

    return executeConfidentialTransfer(
      this.connection,
      this.wallet!,
      params,
      options || this.defaultOptions,
      this.programId
    );
  }

  /**
   * Gets the decrypted balance of the connected wallet's confidential account.
   *
   * @param mint - Token mint
   * @returns Decrypted balance
   */
  async getConfidentialBalance(mint: PublicKey): Promise<BN> {
    this.requireWallet();

    return getConfidentialBalance(
      this.connection,
      this.wallet!,
      mint,
      this.programId
    );
  }

  /**
   * Decrypts incoming confidential transfers.
   *
   * @param mint - Token mint to query
   * @param fromSlot - Start slot (optional)
   * @returns Array of decrypted transfers
   */
  async decryptTransfers(
    mint: PublicKey,
    fromSlot?: number
  ): Promise<DecryptedTransfer[]> {
    this.requireWallet();

    return decryptIncomingTransfers(
      this.connection,
      this.wallet!,
      mint,
      fromSlot,
      this.programId
    );
  }

  /**
   * Encrypts an amount for a recipient.
   *
   * @param amount - Amount to encrypt
   * @param recipientElGamalPubkey - Recipient's ElGamal public key
   * @returns Encrypted amount
   */
  encryptAmount(amount: BN, recipientElGamalPubkey: Uint8Array) {
    return encryptAmount(amount, recipientElGamalPubkey);
  }

  /**
   * Decrypts an encrypted amount using the connected wallet's key.
   *
   * @param encrypted - Encrypted amount
   * @returns Decrypted BN value
   */
  decryptAmount(encrypted: { ephemeralKey: Uint8Array; ciphertext: Uint8Array; randomness: Uint8Array }): BN {
    this.requireWallet();
    return decryptAmount(encrypted, this.elGamalKeypair!.secretKey);
  }

  // ─── Shield Pool Operations ────────────────────────────────────

  /**
   * Deposits tokens into a shield pool.
   *
   * @param params - Deposit parameters
   * @param options - Transaction options
   * @returns Deposit result with note for later withdrawal
   */
  async deposit(
    params: DepositParams,
    options?: TransactionOptions
  ): Promise<DepositResult> {
    this.requireWallet();

    return executeDeposit(
      this.connection,
      this.wallet!,
      params,
      options || this.defaultOptions,
      this.programId
    );
  }

  /**
   * Withdraws tokens from a shield pool using a deposit note.
   *
   * @param params - Withdrawal parameters
   * @param options - Transaction options
   * @returns Withdrawal result
   */
  async withdraw(
    params: WithdrawParams,
    options?: TransactionOptions
  ): Promise<WithdrawResult> {
    this.requireWallet();

    return executeWithdraw(
      this.connection,
      this.wallet!,
      params,
      options || this.defaultOptions,
      this.programId
    );
  }

  /**
   * Fetches the state of a shield pool.
   *
   * @param poolId - Pool address
   * @returns Pool state
   */
  async getPoolState(poolId: PublicKey): Promise<ShieldPoolState> {
    return fetchPoolState(this.connection, poolId, this.programId);
  }

  /**
   * Fetches all pools for a given token mint.
   *
   * @param mint - Token mint
   * @returns Array of pool states
   */
  async getPoolsByMint(mint: PublicKey): Promise<ShieldPoolState[]> {
    return fetchPoolsByMint(this.connection, mint, this.programId);
  }

  /**
   * Fetches all shield pools in the protocol.
   * @returns Array of pool states
   */
  async getAllPools(): Promise<ShieldPoolState[]> {
    return fetchAllPools(this.connection, this.programId);
  }

  /**
   * Checks if a deposit note's nullifier has been spent.
   *
   * @param note - Deposit note or raw nullifier bytes
   * @returns True if already withdrawn
   */
  async isNoteSpent(note: DepositNote | Uint8Array): Promise<boolean> {
    const nullifier = note instanceof Uint8Array ? note : note.nullifier;
    return isNullifierSpent(this.connection, nullifier, this.programId);
  }

  /**
   * Serializes a deposit note to a portable string.
   * @param note - Deposit note
   * @returns Base64-encoded string
   */
  serializeNote(note: DepositNote): string {
    return serializeDepositNote(note);
  }

  /**
   * Deserializes a deposit note from a string.
   * @param encoded - Base64-encoded note
   * @returns Deposit note
   */
  deserializeNote(encoded: string): DepositNote {
    return deserializeDepositNote(encoded);
  }

  /**
   * Estimates the relayer fee for a withdrawal.
   * @returns Estimated fee in lamports
   */
  async estimateRelayerFee(): Promise<BN> {
    return estimateRelayerFee(this.connection);
  }

  // ─── Stealth Address Operations ────────────────────────────────

  /**
   * Generates a stealth meta-address for the connected wallet.
   * @returns Stealth meta-address
   */
  generateStealthMetaAddress(): StealthMetaAddress {
    this.requireWallet();
    return generateStealthMetaAddress(this.wallet!);
  }

  /**
   * Generates a one-time stealth address for a recipient.
   *
   * @param recipientMetaAddress - Recipient's stealth meta-address
   * @returns Stealth address with ephemeral data
   */
  generateStealthAddress(
    recipientMetaAddress: StealthMetaAddress
  ): StealthAddress {
    return generateStealthAddress(recipientMetaAddress);
  }

  /**
   * Registers the wallet's stealth meta-address on-chain.
   *
   * @param label - Optional label
   * @param options - Transaction options
   * @returns Transaction signature
   */
  async registerStealth(
    label: string = "",
    options?: TransactionOptions
  ): Promise<TransactionSignature> {
    this.requireWallet();

    const metaAddress = generateStealthMetaAddress(this.wallet!);
    return registerStealthMetaAddress(
      this.connection,
      this.wallet!,
      metaAddress,
      label,
      options || this.defaultOptions,
      this.programId
    );
  }

  /**
   * Looks up a recipient's stealth meta-address from the registry.
   *
   * @param recipient - Recipient's public key
   * @returns Stealth meta-address
   */
  async lookupStealthAddress(
    recipient: PublicKey
  ): Promise<StealthMetaAddress> {
    return lookupStealthMetaAddress(
      this.connection,
      recipient,
      this.programId
    );
  }

  /**
   * Publishes a stealth announcement after sending to a stealth address.
   *
   * @param ephemeralPubkey - Ephemeral public key
   * @param stealthAddress - Stealth address
   * @param viewTag - View tag
   * @param options - Transaction options
   * @returns Transaction signature
   */
  async announceStealthPayment(
    ephemeralPubkey: Uint8Array,
    stealthAddress: PublicKey,
    viewTag: number,
    options?: TransactionOptions
  ): Promise<TransactionSignature> {
    this.requireWallet();

    return publishStealthAnnouncement(
      this.connection,
      this.wallet!,
      ephemeralPubkey,
      stealthAddress,
      viewTag,
      options || this.defaultOptions,
      this.programId
    );
  }

  /**
   * Scans for incoming stealth payments addressed to this wallet.
   *
   * @param fromSlot - Start scanning from this slot
   * @param toSlot - End scanning at this slot
   * @returns Array of stealth payments
   */
  async scanStealthPayments(
    fromSlot?: number,
    toSlot?: number
  ): Promise<StealthPayment[]> {
    this.requireWallet();

    const viewingKeypair = deriveViewingKeypair(this.wallet!);
    const spendingKeypair = deriveSpendingKeypair(this.wallet!);

    return scanStealthPayments(
      this.connection,
      {
        viewingKey: viewingKeypair.secretKey,
        spendingKey: spendingKeypair.secretKey,
        fromSlot,
        toSlot,
      },
      this.programId
    );
  }

  /**
   * Derives the spending keypair for a received stealth payment.
   *
   * @param ephemeralPubkey - Ephemeral public key from the payment
   * @returns Keypair that can spend the funds at the stealth address
   */
  deriveStealthSpendingKey(ephemeralPubkey: Uint8Array): Keypair {
    this.requireWallet();

    const viewingKeypair = deriveViewingKeypair(this.wallet!);
    const spendingKeypair = deriveSpendingKeypair(this.wallet!);

    return deriveStealthSpendingKey(
      ephemeralPubkey,
      viewingKeypair.secretKey,
      spendingKeypair.secretKey
    );
  }

  /**
   * Fetches a stealth registry entry.
   *
   * @param owner - Owner public key
   * @returns Registry entry
   */
  async getRegistryEntry(
    owner: PublicKey
  ): Promise<StealthRegistryEntry> {
    return fetchRegistryEntry(this.connection, owner, this.programId);
  }

  /**
   * Fetches all stealth registry entries.
   * @returns Array of registry entries
   */
  async getAllRegistryEntries(): Promise<StealthRegistryEntry[]> {
    return fetchAllRegistryEntries(this.connection, this.programId);
  }

  // ─── Internal Helpers ──────────────────────────────────────────

  /**
   * Ensures a wallet is connected, throwing if not.
   */
  private requireWallet(): void {
    if (!this.wallet) {
      throw new WalletNotConnectedError();
    }
  }
}
