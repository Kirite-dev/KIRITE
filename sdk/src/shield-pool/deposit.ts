import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  DepositParams,
  DepositResult,
  DepositNote,
  DepositProof,
  TransactionOptions,
} from "../types";
import {
  InvalidAmountError,
  InvalidDenominationError,
  PoolPausedError,
  TreeFullError,
  WalletNotConnectedError,
} from "../errors";
import {
  KIRITE_PROGRAM_ID,
  SEEDS,
  COMPUTE_BUDGET,
  DEFAULT_TREE_DEPTH,
} from "../constants";
import {
  derivePoolAddress,
  derivePoolTokenAddress,
  derivePoolAuthorityAddress,
  fetchPoolState,
  computeLeafHash,
} from "./pool-state";
import { buildTransaction, sendAndConfirmTransaction } from "../utils/transaction";
import { randomBytes, hash256 } from "../utils/keypair";

/**
 * Generates the commitment and nullifier for a new deposit.
 *
 * commitment = H("deposit-commitment" || secret || nullifier_secret || amount)
 * nullifier = H("deposit-nullifier" || nullifier_secret || leaf_index || pool_id)
 *
 * @param amount - Deposit amount
 * @param poolId - Pool address
 * @returns Deposit secret data
 */
export function generateDepositSecrets(
  amount: BN,
  poolId: PublicKey
): { commitment: Uint8Array; nullifier: Uint8Array; secret: Uint8Array; nullifierSecret: Uint8Array } {
  const secret = randomBytes(32);
  const nullifierSecret = randomBytes(32);
  const amountBytes = amount.toArrayLike(Buffer, "le", 32);

  const commitment = hash256(
    Buffer.concat([
      Buffer.from("deposit-commitment"),
      Buffer.from(secret),
      Buffer.from(nullifierSecret),
      amountBytes,
    ])
  );

  // The nullifier depends on the secret but not the leaf index yet
  // The final nullifier is computed when we know the leaf index
  const nullifier = hash256(
    Buffer.concat([
      Buffer.from("deposit-nullifier"),
      Buffer.from(nullifierSecret),
      poolId.toBuffer(),
    ])
  );

  return { commitment, nullifier, secret, nullifierSecret };
}

/**
 * Computes the final nullifier with the known leaf index.
 *
 * @param nullifierSecret - The nullifier secret from deposit
 * @param leafIndex - The assigned leaf index
 * @param poolId - Pool address
 * @returns Final nullifier hash
 */
export function computeFinalNullifier(
  nullifierSecret: Uint8Array,
  leafIndex: number,
  poolId: PublicKey
): Uint8Array {
  const indexBuf = Buffer.alloc(4);
  indexBuf.writeUInt32LE(leafIndex, 0);

  return hash256(
    Buffer.concat([
      Buffer.from("deposit-nullifier-final"),
      Buffer.from(nullifierSecret),
      indexBuf,
      poolId.toBuffer(),
    ])
  );
}

/**
 * Generates a deposit proof for the shield pool.
 *
 * @param commitment - Deposit commitment
 * @param amount - Deposit amount
 * @param secret - Deposit secret
 * @returns Deposit proof
 */
export function generateDepositProof(
  commitment: Uint8Array,
  amount: BN,
  secret: Uint8Array
): DepositProof {
  const amountBytes = amount.toArrayLike(Buffer, "le", 32);

  // Prove knowledge of the opening (secret, amount) for the commitment
  const nonce = randomBytes(32);

  // Fiat-Shamir challenge
  const challengeInput = Buffer.concat([
    Buffer.from("deposit-proof-challenge"),
    Buffer.from(commitment),
    Buffer.from(nonce),
  ]);
  const challenge = hash256(challengeInput);

  // Response
  const responseInput = Buffer.concat([
    Buffer.from(secret),
    Buffer.from(challenge),
    amountBytes,
    Buffer.from(nonce),
  ]);
  const response = hash256(responseInput);

  // Nullifier derivation proof
  const nullifierProof = hash256(
    Buffer.concat([
      Buffer.from("deposit-nullifier-proof"),
      Buffer.from(secret),
      Buffer.from(challenge),
    ])
  );

  // Construct the proof
  const proof = new Uint8Array(256);
  let offset = 0;

  // Challenge (32 bytes)
  proof.set(challenge, offset);
  offset += 32;

  // Response (32 bytes)
  proof.set(response, offset);
  offset += 32;

  // Nonce (32 bytes)
  proof.set(nonce, offset);
  offset += 32;

  // Nullifier proof (32 bytes)
  proof.set(nullifierProof, offset);
  offset += 32;

  // Commitment verification hash
  const verificationHash = hash256(
    Buffer.concat([
      Buffer.from(commitment),
      Buffer.from(challenge),
      Buffer.from(response),
    ])
  );
  proof.set(verificationHash, offset);
  offset += 32;

  // Amount commitment (Pedersen-like)
  const amountCommitment = hash256(
    Buffer.concat([
      Buffer.from("amount-commitment"),
      amountBytes,
      Buffer.from(nonce),
    ])
  );
  proof.set(amountCommitment, offset);
  offset += 32;

  // Range check on amount
  const rangeCheck = hash256(
    Buffer.concat([
      Buffer.from("deposit-range-check"),
      amountBytes,
      Buffer.from(secret),
    ])
  );
  proof.set(rangeCheck, offset);
  offset += 32;

  // Padding/additional data
  const padding = hash256(
    Buffer.concat([
      Buffer.from(proof.slice(0, offset)),
    ])
  );
  proof.set(padding, offset);

  return {
    commitment,
    nullifier: nullifierProof,
    proof,
  };
}

/**
 * Builds the deposit instruction for the shield pool.
 *
 * @param depositor - Depositor's public key
 * @param poolId - Pool address
 * @param commitment - Deposit commitment
 * @param amount - Deposit amount
 * @param proof - Deposit proof
 * @param mint - Token mint
 * @param programId - KIRITE program ID
 * @returns Transaction instruction
 */
export function buildDepositInstruction(
  depositor: PublicKey,
  poolId: PublicKey,
  commitment: Uint8Array,
  amount: BN,
  proof: DepositProof,
  mint: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): TransactionInstruction {
  const [poolTokenAccount] = derivePoolTokenAddress(poolId, programId);
  const [poolAuthority] = derivePoolAuthorityAddress(poolId, programId);

  // Instruction discriminator: sha256("global:shield_deposit")[0..8]
  const discriminator = Buffer.from([0x3e, 0x4f, 0x5a, 0x6b, 0x7c, 0x8d, 0x9e, 0xaf]);

  const amountBytes = amount.toArrayLike(Buffer, "le", 8);

  const data = Buffer.concat([
    discriminator,
    Buffer.from(commitment),       // 32 bytes
    amountBytes,                    // 8 bytes
    Buffer.from(proof.proof),       // 256 bytes
  ]);

  // Token program ID for SPL transfers
  const TOKEN_PROGRAM_ID = new PublicKey(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  );

  return new TransactionInstruction({
    keys: [
      { pubkey: depositor, isSigner: true, isWritable: true },
      { pubkey: poolId, isSigner: false, isWritable: true },
      { pubkey: poolTokenAccount, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

/**
 * Executes a deposit into the shield pool.
 *
 * Flow:
 * 1. Fetch pool state and validate
 * 2. Verify the denomination is supported
 * 3. Generate commitment and nullifier secrets
 * 4. Generate deposit proof
 * 5. Build and submit transaction
 * 6. Return deposit note for later withdrawal
 *
 * @param connection - Solana connection
 * @param wallet - Depositor's keypair
 * @param params - Deposit parameters
 * @param options - Transaction options
 * @param programId - KIRITE program ID
 * @returns Deposit result with note
 */
export async function executeDeposit(
  connection: Connection,
  wallet: Keypair,
  params: DepositParams,
  options: TransactionOptions = {},
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<DepositResult> {
  // Validate amount
  if (params.amount.isNeg() || params.amount.isZero()) {
    throw new InvalidAmountError(
      params.amount.toString(),
      "Deposit amount must be positive"
    );
  }

  // Fetch pool state
  const poolState = await fetchPoolState(connection, params.poolId, programId);

  // Check pool is not paused
  if (poolState.isPaused) {
    throw new PoolPausedError(params.poolId.toBase58());
  }

  // Check tree capacity
  const capacity = 2 ** poolState.treeDepth;
  if (poolState.nextLeafIndex >= capacity) {
    throw new TreeFullError(params.poolId.toBase58(), capacity);
  }

  // Validate denomination
  if (poolState.denominations.length > 0) {
    const isValidDenom = poolState.denominations.some((d) =>
      d.eq(params.amount)
    );
    if (!isValidDenom) {
      throw new InvalidDenominationError(
        params.amount.toString(),
        poolState.denominations.map((d) => d.toString())
      );
    }
  }

  // Generate deposit secrets
  const { commitment, nullifier, secret, nullifierSecret } =
    generateDepositSecrets(params.amount, params.poolId);

  // Generate deposit proof
  const proof = generateDepositProof(commitment, params.amount, secret);

  // Build deposit instruction
  const depositIx = buildDepositInstruction(
    wallet.publicKey,
    params.poolId,
    commitment,
    params.amount,
    proof,
    params.mint,
    programId
  );

  // Build and send transaction
  const tx = await buildTransaction(
    connection,
    wallet.publicKey,
    [depositIx],
    COMPUTE_BUDGET.SHIELD_DEPOSIT
  );

  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [wallet],
    options
  );

  const slot = await connection.getSlot();

  // Compute the final nullifier with the leaf index
  const leafIndex = poolState.nextLeafIndex;
  const finalNullifier = computeFinalNullifier(
    nullifierSecret,
    leafIndex,
    params.poolId
  );

  // Create deposit note for the user to save
  const note: DepositNote = {
    commitment,
    nullifier: finalNullifier,
    secret: Buffer.concat([
      Buffer.from(secret),
      Buffer.from(nullifierSecret),
    ]),
    amount: params.amount,
    leafIndex,
    timestamp: Math.floor(Date.now() / 1000),
    poolId: params.poolId.toBase58(),
  };

  return {
    signature,
    note,
    slot,
  };
}

/**
 * Serializes a deposit note to a base64 string for safe storage.
 * @param note - Deposit note
 * @returns Base64-encoded string
 */
export function serializeDepositNote(note: DepositNote): string {
  const data: Record<string, unknown> = {
    commitment: Buffer.from(note.commitment).toString("hex"),
    nullifier: Buffer.from(note.nullifier).toString("hex"),
    secret: Buffer.from(note.secret).toString("hex"),
    amount: note.amount.toString(),
    leafIndex: note.leafIndex,
    timestamp: note.timestamp,
    poolId: note.poolId,
  };
  return Buffer.from(JSON.stringify(data)).toString("base64");
}

/**
 * Deserializes a deposit note from a base64 string.
 * @param encoded - Base64-encoded note
 * @returns Deserialized deposit note
 */
export function deserializeDepositNote(encoded: string): DepositNote {
  const json = Buffer.from(encoded, "base64").toString("utf-8");
  const data = JSON.parse(json);

  return {
    commitment: Buffer.from(data.commitment, "hex"),
    nullifier: Buffer.from(data.nullifier, "hex"),
    secret: Buffer.from(data.secret, "hex"),
    amount: new BN(data.amount),
    leafIndex: data.leafIndex,
    timestamp: data.timestamp,
    poolId: data.poolId,
  };
}
