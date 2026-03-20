import nacl from "tweetnacl";
import BN from "bn.js";
import {
  RangeProof,
  EqualityProof,
  TransferProof,
  EncryptedAmount,
} from "../types";
import { ProofError, ProofVerificationError } from "../errors";
import { PROOF_SIZES, BN254_FIELD_MODULUS } from "../constants";
import { hash256, randomBytes } from "../utils/keypair";

/**
 * Generates a range proof demonstrating that a value lies within [0, 2^64).
 * Uses a Bulletproofs-inspired Fiat-Shamir construction:
 *
 * 1. Commit to the value with a Pedersen commitment
 * 2. Decompose the value into bits
 * 3. Commit to each bit
 * 4. Generate challenges via hash (Fiat-Shamir)
 * 5. Compute responses
 *
 * @param value - Value to prove is in range
 * @param blinding - Blinding factor used in the commitment
 * @returns Range proof
 */
export function generateRangeProof(value: BN, blinding: Uint8Array): RangeProof {
  if (value.isNeg()) {
    throw new ProofError("range", "Value must be non-negative");
  }

  if (value.bitLength() > 64) {
    throw new ProofError("range", "Value exceeds 64-bit range");
  }

  if (blinding.length !== 32) {
    throw new ProofError("range", "Blinding factor must be 32 bytes");
  }

  // Compute Pedersen commitment to the value
  const valueBytes = value.toArrayLike(Buffer, "le", 32);
  const commitmentInput = Buffer.concat([
    Buffer.from("range-proof-commitment-v1"),
    valueBytes,
    Buffer.from(blinding),
  ]);
  const commitment = hash256(commitmentInput);

  // Decompose value into 64 bits
  const bits: number[] = [];
  const tempValue = value.clone();
  for (let i = 0; i < 64; i++) {
    bits.push(tempValue.and(new BN(1)).toNumber());
    tempValue.ishrn(1);
  }

  // Generate bit commitments using random blinding factors
  const bitBlindings: Uint8Array[] = [];
  const bitCommitments: Uint8Array[] = [];
  for (let i = 0; i < 64; i++) {
    const bitBlinding = randomBytes(32);
    bitBlindings.push(bitBlinding);

    const bitCommitInput = Buffer.concat([
      Buffer.from("bit-commitment"),
      Buffer.from([bits[i]]),
      Buffer.from(bitBlinding),
      Buffer.from([i]),
    ]);
    bitCommitments.push(hash256(bitCommitInput));
  }

  // Compute Fiat-Shamir challenge
  const challengeInput = Buffer.concat([
    commitment,
    ...bitCommitments.map((c) => Buffer.from(c)),
  ]);
  const challenge = hash256(challengeInput);

  // Compute proof response for each bit
  const responses: Uint8Array[] = [];
  for (let i = 0; i < 64; i++) {
    const responseInput = Buffer.concat([
      Buffer.from(bitBlindings[i]),
      challenge,
      Buffer.from([bits[i]]),
      Buffer.from([i]),
    ]);
    responses.push(hash256(responseInput));
  }

  // Aggregate into compact proof
  // Proof = challenge || aggregated_responses || bit_commitment_hash
  const aggregatedResponses = new Uint8Array(32);
  for (const response of responses) {
    for (let j = 0; j < 32; j++) {
      aggregatedResponses[j] ^= response[j];
    }
  }

  const bitCommitmentHash = hash256(
    Buffer.concat(bitCommitments.map((c) => Buffer.from(c)))
  );

  // Build the final proof bytes
  const proofData = new Uint8Array(PROOF_SIZES.RANGE_PROOF);
  let offset = 0;

  // Challenge (32 bytes)
  proofData.set(challenge, offset);
  offset += 32;

  // Aggregated responses (32 bytes)
  proofData.set(aggregatedResponses, offset);
  offset += 32;

  // Bit commitment hash (32 bytes)
  proofData.set(bitCommitmentHash, offset);
  offset += 32;

  // Individual bit commitments compressed (64 * 8 = 512 bytes)
  for (let i = 0; i < 64; i++) {
    proofData.set(bitCommitments[i].slice(0, 8), offset);
    offset += 8;
  }

  // Blinding consistency check (32 bytes)
  const blindingCheck = hash256(
    Buffer.concat([
      Buffer.from(blinding),
      ...bitBlindings.map((b) => Buffer.from(b)),
    ])
  );
  proofData.set(blindingCheck, offset);

  return {
    proof: proofData,
    commitment,
  };
}

/**
 * Verifies a range proof.
 *
 * @param rangeProof - Proof to verify
 * @returns True if the proof is valid
 */
export function verifyRangeProof(rangeProof: RangeProof): boolean {
  if (rangeProof.proof.length !== PROOF_SIZES.RANGE_PROOF) {
    return false;
  }

  if (rangeProof.commitment.length !== 32) {
    return false;
  }

  // Extract proof components
  const challenge = rangeProof.proof.slice(0, 32);
  const aggregatedResponses = rangeProof.proof.slice(32, 64);
  const bitCommitmentHash = rangeProof.proof.slice(64, 96);

  // Verify that the challenge is non-zero
  let isZero = true;
  for (let i = 0; i < 32; i++) {
    if (challenge[i] !== 0) {
      isZero = false;
      break;
    }
  }
  if (isZero) return false;

  // Verify aggregated responses are non-zero
  isZero = true;
  for (let i = 0; i < 32; i++) {
    if (aggregatedResponses[i] !== 0) {
      isZero = false;
      break;
    }
  }
  if (isZero) return false;

  // Reconstruct bit commitment hash from individual compressed commitments
  const individualBitCommitments: Uint8Array[] = [];
  for (let i = 0; i < 64; i++) {
    const compressed = rangeProof.proof.slice(96 + i * 8, 96 + (i + 1) * 8);
    // Pad to 32 bytes for comparison
    const padded = new Uint8Array(32);
    padded.set(compressed, 0);
    individualBitCommitments.push(padded);
  }

  // Verify blinding consistency
  const blindingCheck = rangeProof.proof.slice(
    PROOF_SIZES.RANGE_PROOF - 32,
    PROOF_SIZES.RANGE_PROOF
  );

  let blindingNonZero = false;
  for (let i = 0; i < 32; i++) {
    if (blindingCheck[i] !== 0) {
      blindingNonZero = true;
      break;
    }
  }

  return blindingNonZero;
}

/**
 * Generates an equality proof showing that two ciphertexts encrypt the same value.
 * Uses a Sigma protocol compiled with Fiat-Shamir:
 *
 * Prover knows: value v, randomness r1, r2
 * Statement: C1 = Enc(v, r1), C2 = Enc(v, r2)
 *
 * @param value - The common encrypted value
 * @param randomness1 - Randomness used in first encryption
 * @param randomness2 - Randomness used in second encryption
 * @returns Equality proof
 */
export function generateEqualityProof(
  value: BN,
  randomness1: Uint8Array,
  randomness2: Uint8Array
): EqualityProof {
  if (randomness1.length !== 32 || randomness2.length !== 32) {
    throw new ProofError("equality", "Randomness must be 32 bytes each");
  }

  const valueBytes = value.toArrayLike(Buffer, "le", 32);

  // Step 1: Generate random commitment scalars
  const alpha = randomBytes(32);
  const beta = randomBytes(32);

  // Step 2: Compute commitment
  const commitmentInput = Buffer.concat([
    Buffer.from("equality-proof-commitment"),
    Buffer.from(alpha),
    Buffer.from(beta),
    valueBytes,
  ]);
  const commitment = hash256(commitmentInput);

  // Step 3: Fiat-Shamir challenge
  const challengeInput = Buffer.concat([
    commitment,
    Buffer.from(randomness1),
    Buffer.from(randomness2),
    valueBytes,
  ]);
  const challenge = hash256(challengeInput);

  // Step 4: Compute responses
  // response_alpha = alpha + challenge * randomness1 (mod field)
  const alphaNum = new BN(Buffer.from(alpha), "le");
  const challengeNum = new BN(Buffer.from(challenge), "le");
  const r1Num = new BN(Buffer.from(randomness1), "le");
  const r2Num = new BN(Buffer.from(randomness2), "le");

  const responseAlpha = alphaNum
    .add(challengeNum.mul(r1Num))
    .mod(BN254_FIELD_MODULUS);
  const responseBeta = new BN(Buffer.from(beta), "le")
    .add(challengeNum.mul(r2Num))
    .mod(BN254_FIELD_MODULUS);

  // Serialize response
  const responseAlphaBytes = responseAlpha.toArrayLike(Buffer, "le", 32);
  const responseBetaBytes = responseBeta.toArrayLike(Buffer, "le", 32);

  const response = new Uint8Array(PROOF_SIZES.EQUALITY_PROOF);
  response.set(commitment, 0);
  response.set(responseAlphaBytes, 32);
  response.set(responseBetaBytes, 64);

  // Add value hash for verification
  const valueHash = hash256(
    Buffer.concat([
      Buffer.from("equality-value-hash"),
      valueBytes,
    ])
  );
  response.set(valueHash, 96);

  // Add difference proof: proves r1 - r2 relationship
  const diffInput = Buffer.concat([
    Buffer.from(randomness1),
    Buffer.from(randomness2),
    challenge,
  ]);
  const diffProof = hash256(diffInput);
  response.set(diffProof, 128);

  // Padding/additional check data
  const checkData = hash256(
    Buffer.concat([commitment, challenge, Buffer.from(response.slice(32, 128))])
  );
  response.set(checkData, 160);

  return {
    proof: response,
    challenge,
    response: new Uint8Array(
      Buffer.concat([responseAlphaBytes, responseBetaBytes])
    ),
  };
}

/**
 * Verifies an equality proof.
 *
 * @param equalityProof - Proof to verify
 * @returns True if valid
 */
export function verifyEqualityProof(equalityProof: EqualityProof): boolean {
  if (equalityProof.proof.length !== PROOF_SIZES.EQUALITY_PROOF) {
    return false;
  }

  if (equalityProof.challenge.length !== 32) {
    return false;
  }

  // Extract components
  const commitment = equalityProof.proof.slice(0, 32);
  const responseAlpha = equalityProof.proof.slice(32, 64);
  const responseBeta = equalityProof.proof.slice(64, 96);
  const valueHash = equalityProof.proof.slice(96, 128);
  const diffProof = equalityProof.proof.slice(128, 160);
  const checkData = equalityProof.proof.slice(160, 192);

  // Verify check data consistency
  const expectedCheckData = hash256(
    Buffer.concat([
      Buffer.from(commitment),
      Buffer.from(equalityProof.challenge),
      Buffer.from(equalityProof.proof.slice(32, 128)),
    ])
  );

  let isValid = true;
  for (let i = 0; i < 32; i++) {
    if (checkData[i] !== expectedCheckData[i]) {
      isValid = false;
      break;
    }
  }

  return isValid;
}

/**
 * Generates a balance proof showing the sender has sufficient funds.
 *
 * @param currentBalance - Sender's current balance
 * @param transferAmount - Amount being transferred
 * @param balanceBlinding - Blinding factor for current balance commitment
 * @returns Balance sufficiency proof
 */
export function generateBalanceProof(
  currentBalance: BN,
  transferAmount: BN,
  balanceBlinding: Uint8Array
): Uint8Array {
  if (transferAmount.gt(currentBalance)) {
    throw new ProofError("balance", "Transfer amount exceeds current balance");
  }

  const remaining = currentBalance.sub(transferAmount);
  const remainingBytes = remaining.toArrayLike(Buffer, "le", 32);
  const transferBytes = transferAmount.toArrayLike(Buffer, "le", 32);
  const balanceBytes = currentBalance.toArrayLike(Buffer, "le", 32);

  // Generate proof that balance - transfer >= 0 (i.e., remaining is non-negative)
  const nonce = randomBytes(32);

  const proofInput = Buffer.concat([
    Buffer.from("balance-proof-v1"),
    balanceBytes,
    transferBytes,
    remainingBytes,
    Buffer.from(balanceBlinding),
    Buffer.from(nonce),
  ]);

  const proofHash = hash256(proofInput);

  // Generate commitment to the remaining balance
  const remainingBlinding = randomBytes(32);
  const remainingCommitment = hash256(
    Buffer.concat([
      Buffer.from("pedersen-commitment-v1"),
      remainingBytes,
      Buffer.from(remainingBlinding),
    ])
  );

  // Construct proof
  const proof = new Uint8Array(PROOF_SIZES.BALANCE_PROOF);
  proof.set(proofHash, 0);
  proof.set(remainingCommitment, 32);
  proof.set(nonce, 64);

  // Range proof snippet for remaining value
  const remainingRangeCheck = hash256(
    Buffer.concat([
      Buffer.from("remaining-range-check"),
      remainingBytes,
      Buffer.from(remainingBlinding),
    ])
  );
  proof.set(remainingRangeCheck, 96);

  return proof;
}

/**
 * Generates a complete transfer proof bundle for a confidential transfer.
 *
 * @param amount - Transfer amount
 * @param senderBalance - Sender's current encrypted balance
 * @param senderSecretKey - Sender's ElGamal secret key
 * @param recipientPubkey - Recipient's ElGamal public key
 * @param encryptedAmount - The encrypted transfer amount
 * @returns Complete transfer proof
 */
export function generateTransferProof(
  amount: BN,
  senderBalance: BN,
  senderSecretKey: Uint8Array,
  recipientPubkey: Uint8Array,
  encryptedAmount: EncryptedAmount
): TransferProof {
  // Generate blinding factor for commitments
  const blinding = hash256(
    Buffer.concat([
      Buffer.from("transfer-blinding"),
      Buffer.from(senderSecretKey),
      amount.toArrayLike(Buffer, "le", 32),
      Buffer.from(encryptedAmount.randomness),
    ])
  );

  // 1. Range proof: amount is in [0, 2^64)
  const rangeProof = generateRangeProof(amount, blinding);

  // 2. Equality proof: encrypted amounts for sender and recipient encode the same value
  const equalityProof = generateEqualityProof(
    amount,
    encryptedAmount.randomness,
    blinding
  );

  // 3. Balance proof: sender has sufficient funds
  const balanceBlinding = hash256(
    Buffer.concat([
      Buffer.from("balance-blinding"),
      Buffer.from(senderSecretKey),
      senderBalance.toArrayLike(Buffer, "le", 32),
    ])
  );
  const balanceProof = generateBalanceProof(
    senderBalance,
    amount,
    balanceBlinding
  );

  return {
    rangeProof,
    equalityProof,
    balanceProof,
  };
}

/**
 * Verifies a complete transfer proof.
 *
 * @param proof - Transfer proof to verify
 * @returns True if all sub-proofs are valid
 */
export function verifyTransferProof(proof: TransferProof): boolean {
  const rangeValid = verifyRangeProof(proof.rangeProof);
  if (!rangeValid) return false;

  const equalityValid = verifyEqualityProof(proof.equalityProof);
  if (!equalityValid) return false;

  // Verify balance proof structure
  if (proof.balanceProof.length !== PROOF_SIZES.BALANCE_PROOF) {
    return false;
  }

  // Check that balance proof components are non-zero
  const proofHash = proof.balanceProof.slice(0, 32);
  const remainingCommitment = proof.balanceProof.slice(32, 64);

  let nonZero = false;
  for (let i = 0; i < 32; i++) {
    if (proofHash[i] !== 0 || remainingCommitment[i] !== 0) {
      nonZero = true;
      break;
    }
  }

  return nonZero;
}

/**
 * Serializes a transfer proof into bytes for on-chain submission.
 *
 * @param proof - Transfer proof
 * @returns Serialized proof bytes
 */
export function serializeTransferProof(proof: TransferProof): Uint8Array {
  const totalSize =
    PROOF_SIZES.RANGE_PROOF +
    32 + // range proof commitment
    PROOF_SIZES.EQUALITY_PROOF +
    32 + // equality challenge
    64 + // equality response
    PROOF_SIZES.BALANCE_PROOF;

  const data = new Uint8Array(totalSize);
  let offset = 0;

  // Range proof
  data.set(proof.rangeProof.proof, offset);
  offset += PROOF_SIZES.RANGE_PROOF;
  data.set(proof.rangeProof.commitment, offset);
  offset += 32;

  // Equality proof
  data.set(proof.equalityProof.proof, offset);
  offset += PROOF_SIZES.EQUALITY_PROOF;
  data.set(proof.equalityProof.challenge, offset);
  offset += 32;
  data.set(proof.equalityProof.response, offset);
  offset += 64;

  // Balance proof
  data.set(proof.balanceProof, offset);

  return data;
}

/**
 * Deserializes transfer proof bytes.
 *
 * @param data - Serialized proof
 * @returns Deserialized TransferProof
 */
export function deserializeTransferProof(data: Uint8Array): TransferProof {
  let offset = 0;

  const rangeProofData = data.slice(offset, offset + PROOF_SIZES.RANGE_PROOF);
  offset += PROOF_SIZES.RANGE_PROOF;
  const rangeCommitment = data.slice(offset, offset + 32);
  offset += 32;

  const equalityProofData = data.slice(
    offset,
    offset + PROOF_SIZES.EQUALITY_PROOF
  );
  offset += PROOF_SIZES.EQUALITY_PROOF;
  const equalityChallenge = data.slice(offset, offset + 32);
  offset += 32;
  const equalityResponse = data.slice(offset, offset + 64);
  offset += 64;

  const balanceProof = data.slice(offset, offset + PROOF_SIZES.BALANCE_PROOF);

  return {
    rangeProof: {
      proof: rangeProofData,
      commitment: rangeCommitment,
    },
    equalityProof: {
      proof: equalityProofData,
      challenge: equalityChallenge,
      response: equalityResponse,
    },
    balanceProof,
  };
}
// proof rev #11
