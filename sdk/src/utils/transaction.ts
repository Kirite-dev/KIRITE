import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionSignature,
  ComputeBudgetProgram,
  SystemProgram,
  Commitment,
  SendOptions,
  Signer,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import {
  TransactionError,
  ConfirmationTimeoutError,
  SimulationError,
} from "../errors";
import { DEFAULT_RETRY_CONFIG, DEFAULT_CONFIRM_TIMEOUT } from "../constants";
import { RetryConfig, TransactionOptions } from "../types";

/**
 * Builds a transaction with compute budget and instructions.
 * @param connection - Solana connection
 * @param payer - Transaction fee payer
 * @param instructions - Transaction instructions
 * @param computeUnits - Compute unit limit (optional)
 * @param priorityFee - Priority fee in micro-lamports per compute unit (optional)
 * @returns Built Transaction ready for signing
 */
export async function buildTransaction(
  connection: Connection,
  payer: PublicKey,
  instructions: TransactionInstruction[],
  computeUnits?: number,
  priorityFee?: number
): Promise<Transaction> {
  const tx = new Transaction();

  if (computeUnits) {
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: computeUnits,
      })
    );
  }

  if (priorityFee && priorityFee > 0) {
    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: priorityFee,
      })
    );
  }

  for (const ix of instructions) {
    tx.add(ix);
  }

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = payer;

  return tx;
}

/**
 * Builds a versioned transaction (v0) with address lookup tables support.
 * @param connection - Solana connection
 * @param payer - Fee payer
 * @param instructions - Instructions to include
 * @param computeUnits - Compute unit limit
 * @param priorityFee - Priority fee in micro-lamports
 * @returns VersionedTransaction
 */
export async function buildVersionedTransaction(
  connection: Connection,
  payer: PublicKey,
  instructions: TransactionInstruction[],
  computeUnits?: number,
  priorityFee?: number
): Promise<VersionedTransaction> {
  const allInstructions: TransactionInstruction[] = [];

  if (computeUnits) {
    allInstructions.push(
      ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits })
    );
  }

  if (priorityFee && priorityFee > 0) {
    allInstructions.push(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee })
    );
  }

  allInstructions.push(...instructions);

  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const messageV0 = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: allInstructions,
  }).compileToV0Message();

  return new VersionedTransaction(messageV0);
}

/**
 * Signs and sends a transaction with retry logic.
 * @param connection - Solana connection
 * @param transaction - Transaction to send
 * @param signers - Transaction signers
 * @param options - Transaction options
 * @param retryConfig - Retry configuration
 * @returns Transaction signature
 */
export async function signAndSendTransaction(
  connection: Connection,
  transaction: Transaction,
  signers: Signer[],
  options: TransactionOptions = {},
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<TransactionSignature> {
  transaction.sign(...signers);

  let lastError: Error | undefined;
  let attempt = 0;

  while (attempt <= retryConfig.maxRetries) {
    try {
      const sendOptions: SendOptions = {
        skipPreflight: options.skipPreflight ?? false,
        preflightCommitment: options.preflightCommitment ?? "confirmed",
        maxRetries: 0, // We handle retries ourselves
      };

      const signature = await connection.sendRawTransaction(
        transaction.serialize(),
        sendOptions
      );

      return signature;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (isNonRetryableError(lastError)) {
        throw wrapSendError(lastError);
      }

      attempt++;
      if (attempt <= retryConfig.maxRetries) {
        const delay = calculateBackoff(attempt, retryConfig);
        await sleep(delay);

        // Refresh blockhash for retry
        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash("confirmed");
        transaction.recentBlockhash = blockhash;
        transaction.lastValidBlockHeight = lastValidBlockHeight;
        transaction.sign(...signers);
      }
    }
  }

  throw wrapSendError(lastError!);
}

/**
 * Sends a transaction and waits for confirmation.
 * @param connection - Solana connection
 * @param transaction - Transaction to send
 * @param signers - Signers
 * @param options - Transaction options
 * @param retryConfig - Retry configuration
 * @param confirmTimeout - Confirmation timeout in ms
 * @returns Confirmed transaction signature
 */
export async function sendAndConfirmTransaction(
  connection: Connection,
  transaction: Transaction,
  signers: Signer[],
  options: TransactionOptions = {},
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
  confirmTimeout: number = DEFAULT_CONFIRM_TIMEOUT
): Promise<TransactionSignature> {
  const signature = await signAndSendTransaction(
    connection,
    transaction,
    signers,
    options,
    retryConfig
  );

  const commitment = options.commitment ?? "confirmed";

  try {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash(commitment);

    const result = await Promise.race([
      connection.confirmTransaction(
        {
          signature,
          blockhash,
          lastValidBlockHeight,
        },
        commitment
      ),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new ConfirmationTimeoutError(signature, confirmTimeout)),
          confirmTimeout
        )
      ),
    ]);

    if (result.value.err) {
      const logs = await getTransactionLogs(connection, signature);
      throw new TransactionError(
        `Transaction confirmed but failed: ${JSON.stringify(result.value.err)}`,
        signature,
        logs
      );
    }

    return signature;
  } catch (err) {
    if (err instanceof TransactionError || err instanceof ConfirmationTimeoutError) {
      throw err;
    }
    throw new TransactionError(
      `Failed to confirm transaction: ${err instanceof Error ? err.message : String(err)}`,
      signature
    );
  }
}

/**
 * Simulates a transaction and returns the logs.
 * @param connection - Solana connection
 * @param transaction - Transaction to simulate
 * @returns Simulation logs
 * @throws SimulationError if simulation fails
 */
export async function simulateTransaction(
  connection: Connection,
  transaction: Transaction
): Promise<string[]> {
  const result = await connection.simulateTransaction(transaction);

  if (result.value.err) {
    throw new SimulationError(result.value.logs || []);
  }

  return result.value.logs || [];
}

/**
 * Gets transaction logs for a confirmed transaction.
 * @param connection - Solana connection
 * @param signature - Transaction signature
 * @returns Log messages
 */
export async function getTransactionLogs(
  connection: Connection,
  signature: TransactionSignature
): Promise<string[]> {
  try {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
    });
    return tx?.meta?.logMessages || [];
  } catch {
    return [];
  }
}

/**
 * Calculates exponential backoff delay with jitter.
 * @param attempt - Current attempt number (1-based)
 * @param config - Retry configuration
 * @returns Delay in milliseconds
 */
function calculateBackoff(attempt: number, config: RetryConfig): number {
  const exponentialDelay =
    config.baseDelay * Math.pow(config.backoffMultiplier, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, config.maxDelay);
  // Add jitter: random value between 0 and 50% of the delay
  const jitter = Math.random() * cappedDelay * 0.5;
  return Math.floor(cappedDelay + jitter);
}

/**
 * Checks if an error is non-retryable.
 */
function isNonRetryableError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  const nonRetryable = [
    "insufficient funds",
    "insufficient lamports",
    "invalid account data",
    "account not found",
    "blockhash not found",
    "instruction error",
    "custom program error",
    "invalid instruction",
    "privilege escalation",
  ];
  return nonRetryable.some((pattern) => msg.includes(pattern));
}

/**
 * Wraps a raw send error into a TransactionError.
 */
function wrapSendError(err: Error): TransactionError {
  if (err instanceof TransactionError) {
    return err;
  }

  const logsMatch = err.message.match(/logs:\s*\[(.*?)\]/s);
  const logs = logsMatch
    ? logsMatch[1].split(",").map((l) => l.trim().replace(/^"|"$/g, ""))
    : undefined;

  return new TransactionError(err.message, undefined, logs);
}

/**
 * Sleeps for the specified duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates a memo instruction.
 * @param memo - Memo text
 * @param signer - Signer public key
 * @returns Transaction instruction
 */
export function createMemoInstruction(
  memo: string,
  signer: PublicKey
): TransactionInstruction {
  const MEMO_PROGRAM_ID = new PublicKey(
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
  );

  return new TransactionInstruction({
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(memo, "utf-8"),
  });
}

/**
 * Estimates the transaction fee for the given instructions.
 * @param connection - Solana connection
 * @param payer - Fee payer
 * @param instructions - Instructions
 * @returns Estimated fee in lamports
 */
export async function estimateTransactionFee(
  connection: Connection,
  payer: PublicKey,
  instructions: TransactionInstruction[]
): Promise<number> {
  const tx = await buildTransaction(connection, payer, instructions);
  const message = tx.compileMessage();
  const feeResult = await connection.getFeeForMessage(message);
  return feeResult.value ?? 5000;
}
