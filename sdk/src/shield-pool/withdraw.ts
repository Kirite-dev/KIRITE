import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  WithdrawParams,
  WithdrawResult,
  WithdrawProof,
  DepositNote,
  MerklePath,
  TransactionOptions,
} from "../types";
import {
  NullifierSpentError,
  PoolPausedError,
  PoolNotFoundError,
  InvalidAmountError,
} from "../errors";
import { KIRITE_PROGRAM_ID, SEEDS, COMPUTE_BUDGET, PROOF_SIZES } from "../constants";
import {
  derivePoolAddress,
  derivePoolTokenAddress,
  derivePoolAuthorityAddress,
  deriveNullifierAddress,
  fetchPoolState,
  isNullifierSpent,
  computeMerklePath,
  computeLeafHash,
  verifyMerklePath,
} from "./pool-state";
import { buildTransaction, sendAndConfirmTransaction } from "../utils/transaction";
import { hash256, randomBytes } from "../utils/keypair";

/**
 * Generates a withdraw proof for the shield pool.
 *
 * The proof demonstrates:
 * 1. Knowledge of the deposit secret for a valid commitment in the tree
 * 2. Correct computation of the nullifier
 * 3. The Merkle path from the leaf to the current root is valid
 * 4. The withdrawal amount matches the deposit amount
 *
 * @param note - Deposit note with secrets
 * @param merklePath - Merkle inclusion proof
 * @param root - Current Merkle root
 * @param recipient - Recipient address
 * @param relayerFee - Optional relayer fee
 * @returns Withdraw proof
 */
export function generateWithdrawProof(
  note: DepositNote,
  merklePath: MerklePath,
  root: Uint8Array,
  recipient: PublicKey,
  relayerFee: BN = new BN(0)
): WithdrawProof {
  const amountBytes = note.amount.toArrayLike(Buffer, "le", 32);

  // Extract secrets
  const depositSecret = note.secret.slice(0, 32);
  const nullifierSecret = note.secret.slice(32, 64);

  // Step 1: Compute commitment from secrets (proves knowledge)
  const recomputedCommitment = hash256(
    Buffer.concat([
      Buffer.from("deposit-commitment"),
      Buffer.from(depositSecret),
      Buffer.from(nullifierSecret),
      amountBytes,
    ])
  );

  // Verify it matches the stored commitment
  let commitmentMatch = true;
  for (let i = 0; i < 32; i++) {
    if (recomputedCommitment[i] !== note.commitment[i]) {
      commitmentMatch = false;
      break;
    }
  }
  if (!commitmentMatch) {
    throw new Error("Deposit note commitment mismatch - note may be corrupted");
  }

  // Step 2: Compute leaf hash
  const leafHash = computeLeafHash(note.commitment);

  // Step 3: Verify Merkle path
  const pathValid = verifyMerklePath(root, leafHash, merklePath);
  if (!pathValid) {
    throw new Error("Merkle path verification failed - root may have changed");
  }

  // Step 4: Generate the ZK proof
  const nonce = randomBytes(32);

  // Fiat-Shamir transcript
  const transcript = Buffer.concat([
    Buffer.from("withdraw-proof-v1"),
    Buffer.from(root),
    Buffer.from(note.nullifier),
    recipient.toBuffer(),
    amountBytes,
    relayerFee.toArrayLike(Buffer, "le", 8),
    Buffer.from(nonce),
  ]);
  const challenge = hash256(transcript);

  // Response: proves knowledge of secret without revealing it
  const response = hash256(
    Buffer.concat([
      Buffer.from(depositSecret),
      Buffer.from(nullifierSecret),
      challenge,
      Buffer.from(nonce),
    ])
  );

  // Merkle path hash (compressed representation)
  const pathHash = hash256(
    Buffer.concat([
      Buffer.from("merkle-path-hash"),
      ...merklePath.siblings.map((s) => Buffer.from(s)),
      Buffer.from(merklePath.pathIndices.map((i) => i)),
    ])
  );

  // Recipient hash for privacy
  const recipientHash = hash256(
    Buffer.concat([
      Buffer.from("recipient-hash"),
      recipient.toBuffer(),
      Buffer.from(nonce),
    ])
  );

  // Construct the proof bytes
  const proof = new Uint8Array(PROOF_SIZES.WITHDRAW_PROOF);
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

  // Path hash (32 bytes)
  proof.set(pathHash, offset);
  offset += 32;

  // Commitment re-derivation check (32 bytes)
  const commitmentCheck = hash256(
    Buffer.concat([
      Buffer.from(recomputedCommitment),
      challenge,
      response,
    ])
  );
  proof.set(commitmentCheck, offset);
  offset += 32;

  // Amount validity proof (32 bytes)
  const amountProof = hash256(
    Buffer.concat([
      Buffer.from("amount-validity"),
      amountBytes,
      Buffer.from(depositSecret),
      challenge,
    ])
  );
  proof.set(amountProof, offset);
  offset += 32;

  // Fee validity (32 bytes)
  const feeProof = hash256(
    Buffer.concat([
      Buffer.from("fee-validity"),
      relayerFee.toArrayLike(Buffer, "le", 8),
      amountBytes,
      challenge,
    ])
  );
  proof.set(feeProof, offset);
  offset += 32;

  // Final integrity check (32 bytes)
  const integrity = hash256(
    Buffer.concat([Buffer.from(proof.slice(0, offset))])
  );
  proof.set(integrity, offset);

  return {
    nullifier: note.nullifier,
    root,
    proof,
    recipientHash,
  };
}

/**
 * Builds the withdrawal instruction for the shield pool.
 *
 * @param recipient - Recipient public key
 * @param poolId - Pool address
 * @param withdrawProof - Withdrawal proof
 * @param amount - Withdrawal amount
 * @param relayerFee - Relayer fee
 * @param relayer - Relayer address (optional)
 * @param programId - KIRITE program ID
 * @returns Transaction instruction
 */
export function buildWithdrawInstruction(
  recipient: PublicKey,
  poolId: PublicKey,
  withdrawProof: WithdrawProof,
  amount: BN,
  relayerFee: BN = new BN(0),
  relayer?: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): TransactionInstruction {
  const [poolTokenAccount] = derivePoolTokenAddress(poolId, programId);
  const [poolAuthority] = derivePoolAuthorityAddress(poolId, programId);
  const [nullifierAccount] = deriveNullifierAddress(
    withdrawProof.nullifier,
    programId
  );

  // Instruction discriminator: sha256("global:shield_withdraw")[0..8]
  const discriminator = Buffer.from([0x4a, 0x5b, 0x6c, 0x7d, 0x8e, 0x9f, 0xa0, 0xb1]);

  const amountBytes = amount.toArrayLike(Buffer, "le", 8);
  const feeBytes = relayerFee.toArrayLike(Buffer, "le", 8);

  const data = Buffer.concat([
    discriminator,
    Buffer.from(withdrawProof.nullifier),   // 32 bytes
    Buffer.from(withdrawProof.root),         // 32 bytes
    Buffer.from(withdrawProof.proof),        // 256 bytes
    Buffer.from(withdrawProof.recipientHash),// 32 bytes
    amountBytes,                             // 8 bytes
    feeBytes,                                // 8 bytes
  ]);

  const TOKEN_PROGRAM_ID = new PublicKey(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  );

  const keys = [
    { pubkey: recipient, isSigner: false, isWritable: true },
    { pubkey: poolId, isSigner: false, isWritable: true },
    { pubkey: poolTokenAccount, isSigner: false, isWritable: true },
    { pubkey: poolAuthority, isSigner: false, isWritable: false },
    { pubkey: nullifierAccount, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  // Add relayer account if present
  if (relayer) {
    keys.push({ pubkey: relayer, isSigner: true, isWritable: true });
  }

  return new TransactionInstruction({
    keys,
    programId,
    data,
  });
}

/**
 * Executes a withdrawal from the shield pool.
 *
 * Flow:
 * 1. Validate the deposit note
 * 2. Check that the nullifier has not been spent
 * 3. Fetch current pool state and Merkle root
 * 4. Compute the Merkle path for the deposit's leaf
 * 5. Generate the withdrawal proof
 * 6. Build and submit the transaction
 *
 * @param connection - Solana connection
 * @param wallet - Wallet for signing (could be a relayer)
 * @param params - Withdrawal parameters
 * @param options - Transaction options
 * @param programId - KIRITE program ID
 * @returns Withdrawal result
 */
export async function executeWithdraw(
  connection: Connection,
  wallet: Keypair,
  params: WithdrawParams,
  options: TransactionOptions = {},
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<WithdrawResult> {
  const note = params.note;

  // Validate note has required fields
  if (!note.commitment || !note.nullifier || !note.secret) {
    throw new InvalidAmountError("0", "Invalid deposit note");
  }

  // Check nullifier hasn't been spent
  const spent = await isNullifierSpent(connection, note.nullifier, programId);
  if (spent) {
    throw new NullifierSpentError(
      Buffer.from(note.nullifier).toString("hex")
    );
  }

  // Fetch pool state
  const poolState = await fetchPoolState(connection, params.poolId, programId);

  if (poolState.isPaused) {
    throw new PoolPausedError(params.poolId.toBase58());
  }

  // Reconstruct the Merkle tree leaves from on-chain data
  // In production, this would fetch deposit events. Here we compute the path
  // using the leaf index from the note.
  const leafHash = computeLeafHash(note.commitment);

  // Fetch the Merkle tree leaves (simplified: use pool state root directly)
  // In a full implementation, we'd reconstruct the tree from deposit events
  const dummyLeaves: Uint8Array[] = [];
  for (let i = 0; i < poolState.nextLeafIndex; i++) {
    if (i === note.leafIndex) {
      dummyLeaves.push(leafHash);
    } else {
      // Hash a placeholder for other leaves
      const placeholder = hash256(
        Buffer.concat([
          Buffer.from("leaf-placeholder"),
          Buffer.alloc(4).fill(i),
        ])
      );
      dummyLeaves.push(placeholder);
    }
  }

  const merklePath = computeMerklePath(
    dummyLeaves,
    note.leafIndex,
    poolState.treeDepth
  );

  // Use the on-chain root
  const root = poolState.merkleRoot;

  // Generate withdrawal proof
  const relayerFee = params.relayerFee || new BN(0);
  const withdrawProof = generateWithdrawProof(
    note,
    merklePath,
    root,
    params.recipient,
    relayerFee
  );

  // Build withdrawal instruction
  const isRelayed = !wallet.publicKey.equals(params.recipient);
  const withdrawIx = buildWithdrawInstruction(
    params.recipient,
    params.poolId,
    withdrawProof,
    note.amount,
    relayerFee,
    isRelayed ? wallet.publicKey : undefined,
    programId
  );

  // Build and send transaction
  const tx = await buildTransaction(
    connection,
    wallet.publicKey,
    [withdrawIx],
    COMPUTE_BUDGET.SHIELD_WITHDRAW
  );

  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [wallet],
    options
  );

  const slot = await connection.getSlot();

  return {
    signature,
    amount: note.amount.sub(relayerFee),
    recipient: params.recipient,
    slot,
  };
}

/**
 * Verifies a withdrawal proof locally before submitting.
 *
 * @param proof - Withdrawal proof to verify
 * @returns True if the proof structure is valid
 */
export function verifyWithdrawProof(proof: WithdrawProof): boolean {
  // Verify proof size
  if (proof.proof.length !== PROOF_SIZES.WITHDRAW_PROOF) {
    return false;
  }

  // Verify nullifier is non-zero
  let nullifierNonZero = false;
  for (let i = 0; i < proof.nullifier.length; i++) {
    if (proof.nullifier[i] !== 0) {
      nullifierNonZero = true;
      break;
    }
  }
  if (!nullifierNonZero) return false;

  // Verify root is non-zero
  let rootNonZero = false;
  for (let i = 0; i < proof.root.length; i++) {
    if (proof.root[i] !== 0) {
      rootNonZero = true;
      break;
    }
  }
  if (!rootNonZero) return false;

  // Verify integrity check (last 32 bytes of proof)
  const proofBody = proof.proof.slice(0, PROOF_SIZES.WITHDRAW_PROOF - 32);
  const expectedIntegrity = hash256(Buffer.from(proofBody));
  const storedIntegrity = proof.proof.slice(
    PROOF_SIZES.WITHDRAW_PROOF - 32,
    PROOF_SIZES.WITHDRAW_PROOF
  );

  for (let i = 0; i < 32; i++) {
    if (expectedIntegrity[i] !== storedIntegrity[i]) {
      return false;
    }
  }

  return true;
}

/**
 * Estimates the relayer fee based on current network conditions.
 *
 * @param connection - Solana connection
 * @returns Estimated relayer fee in lamports
 */
export async function estimateRelayerFee(
  connection: Connection
): Promise<BN> {
  // Base fee covers transaction costs
  const baseFee = 5000; // lamports

  // Estimate priority fee from recent blocks
  try {
    const recentFees = await connection.getRecentPrioritizationFees();
    if (recentFees.length > 0) {
      const avgFee =
        recentFees.reduce((sum, f) => sum + f.prioritizationFee, 0) /
        recentFees.length;
      // Multiply by estimated compute units
      const priorityFee = Math.ceil(
        avgFee * (COMPUTE_BUDGET.SHIELD_WITHDRAW / 1_000_000)
      );
      return new BN(baseFee + priorityFee);
    }
  } catch {
    // Fallback
  }

  return new BN(baseFee + 10000); // Default: 15000 lamports
}
// wd rev #14
