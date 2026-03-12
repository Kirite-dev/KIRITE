import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  ShieldPoolState,
  ShieldPoolConfig,
  MerklePath,
  MerkleNode,
} from "../types";
import {
  PoolNotFoundError,
  AccountNotFoundError,
  NullifierSpentError,
} from "../errors";
import {
  KIRITE_PROGRAM_ID,
  SEEDS,
  DEFAULT_TREE_DEPTH,
  ZERO_VALUE,
  DISCRIMINATOR_SIZE,
  DEFAULT_DENOMINATIONS,
} from "../constants";
import { fetchAccountOrThrow, fetchProgramAccounts } from "../utils/connection";
import { hash256 } from "../utils/keypair";

/**
 * Derives the shield pool PDA address.
 * @param mint - Token mint
 * @param poolIndex - Pool index (for multiple pools per mint)
 * @param programId - Program ID
 * @returns PDA and bump
 */
export function derivePoolAddress(
  mint: PublicKey,
  poolIndex: number = 0,
  programId: PublicKey = KIRITE_PROGRAM_ID
): [PublicKey, number] {
  const indexBuf = Buffer.alloc(4);
  indexBuf.writeUInt32LE(poolIndex, 0);
  return PublicKey.findProgramAddressSync(
    [SEEDS.POOL_STATE, mint.toBuffer(), indexBuf],
    programId
  );
}

/**
 * Derives the pool token account PDA.
 * @param poolAddress - Pool state address
 * @param programId - Program ID
 * @returns PDA and bump
 */
export function derivePoolTokenAddress(
  poolAddress: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.POOL_TOKEN, poolAddress.toBuffer()],
    programId
  );
}

/**
 * Derives the pool authority PDA.
 * @param poolAddress - Pool state address
 * @param programId - Program ID
 * @returns PDA and bump
 */
export function derivePoolAuthorityAddress(
  poolAddress: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.POOL_AUTHORITY, poolAddress.toBuffer()],
    programId
  );
}

/**
 * Derives the nullifier PDA for checking double-spend.
 * @param nullifier - Nullifier hash
 * @param programId - Program ID
 * @returns PDA and bump
 */
export function deriveNullifierAddress(
  nullifier: Uint8Array,
  programId: PublicKey = KIRITE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.NULLIFIER, Buffer.from(nullifier)],
    programId
  );
}

/**
 * Parses on-chain pool state account data into a ShieldPoolState object.
 * @param data - Raw account data
 * @param poolId - Pool address
 * @returns Parsed pool state
 */
export function parsePoolState(
  data: Buffer,
  poolId: PublicKey
): ShieldPoolState {
  let offset = DISCRIMINATOR_SIZE;

  const authority = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const mint = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const tokenAccount = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const merkleRoot = new Uint8Array(data.slice(offset, offset + 32));
  offset += 32;

  const nextLeafIndex = data.readUInt32LE(offset);
  offset += 4;

  const treeDepth = data.readUInt8(offset);
  offset += 1;

  const totalDepositsLow = data.readUInt32LE(offset);
  const totalDepositsHigh = data.readUInt32LE(offset + 4);
  const totalDeposits = new BN(totalDepositsHigh).shln(32).add(new BN(totalDepositsLow));
  offset += 8;

  const totalWithdrawalsLow = data.readUInt32LE(offset);
  const totalWithdrawalsHigh = data.readUInt32LE(offset + 4);
  const totalWithdrawals = new BN(totalWithdrawalsHigh).shln(32).add(new BN(totalWithdrawalsLow));
  offset += 8;

  const denomCount = data.readUInt8(offset);
  offset += 1;

  const denominations: BN[] = [];
  for (let i = 0; i < denomCount; i++) {
    const denomLow = data.readUInt32LE(offset);
    const denomHigh = data.readUInt32LE(offset + 4);
    denominations.push(new BN(denomHigh).shln(32).add(new BN(denomLow)));
    offset += 8;
  }

  const isPaused = data.readUInt8(offset) === 1;
  offset += 1;

  const bump = data.readUInt8(offset);

  return {
    poolId,
    authority,
    mint,
    tokenAccount,
    merkleRoot,
    nextLeafIndex,
    treeDepth,
    totalDeposits,
    totalWithdrawals,
    denominations,
    isPaused,
    bump,
  };
}

/**
 * Fetches and parses the on-chain state of a shield pool.
 * @param connection - Solana connection
 * @param poolId - Pool address
 * @param programId - Program ID
 * @returns Parsed pool state
 */
export async function fetchPoolState(
  connection: Connection,
  poolId: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<ShieldPoolState> {
  const account = await fetchAccountOrThrow(connection, poolId, "ShieldPool");

  if (!account.owner.equals(programId)) {
    throw new PoolNotFoundError(poolId.toBase58());
  }

  return parsePoolState(account.data, poolId);
}

/**
 * Fetches all shield pools for a given token mint.
 * @param connection - Solana connection
 * @param mint - Token mint to filter by
 * @param programId - Program ID
 * @returns Array of pool states
 */
export async function fetchPoolsByMint(
  connection: Connection,
  mint: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<ShieldPoolState[]> {
  const accounts = await fetchProgramAccounts(connection, programId, [
    {
      memcmp: {
        offset: DISCRIMINATOR_SIZE + 32, // Skip discriminator + authority
        bytes: mint.toBase58(),
      },
    },
  ]);

  return accounts.map(({ pubkey, account }) =>
    parsePoolState(account.data, pubkey)
  );
}

/**
 * Fetches all shield pools in the protocol.
 * @param connection - Solana connection
 * @param programId - Program ID
 * @returns Array of pool states
 */
export async function fetchAllPools(
  connection: Connection,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<ShieldPoolState[]> {
  // Filter by the pool state discriminator
  const accounts = await fetchProgramAccounts(connection, programId, [
    {
      memcmp: {
        offset: 0,
        bytes: "2Q8", // Base58 of the pool state discriminator prefix
      },
    },
  ]);

  const pools: ShieldPoolState[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      pools.push(parsePoolState(account.data, pubkey));
    } catch {
      // Skip malformed accounts
    }
  }

  return pools;
}

/**
 * Checks if a nullifier has been spent.
 * @param connection - Solana connection
 * @param nullifier - Nullifier to check
 * @param programId - Program ID
 * @returns True if the nullifier has been used
 */
export async function isNullifierSpent(
  connection: Connection,
  nullifier: Uint8Array,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<boolean> {
  const [nullifierAddr] = deriveNullifierAddress(nullifier, programId);

  try {
    const account = await connection.getAccountInfo(nullifierAddr);
    return account !== null;
  } catch {
    return false;
  }
}

/**
 * Computes the Merkle root from a set of leaves.
 * @param leaves - Array of leaf hashes
 * @param depth - Tree depth
 * @returns Merkle root hash
 */
export function computeMerkleRoot(
  leaves: Uint8Array[],
  depth: number = DEFAULT_TREE_DEPTH
): Uint8Array {
  const capacity = 2 ** depth;

  // Pad with zero values
  const paddedLeaves = [...leaves];
  while (paddedLeaves.length < capacity) {
    paddedLeaves.push(ZERO_VALUE);
  }

  // Build the tree bottom-up
  let currentLevel = paddedLeaves;
  for (let level = 0; level < depth; level++) {
    const nextLevel: Uint8Array[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = currentLevel[i + 1] || ZERO_VALUE;
      const parent = hashPair(left, right);
      nextLevel.push(parent);
    }
    currentLevel = nextLevel;
  }

  return currentLevel[0];
}

/**
 * Computes a Merkle path (proof of inclusion) for a leaf at a given index.
 * @param leaves - All leaves in the tree
 * @param leafIndex - Index of the leaf to prove
 * @param depth - Tree depth
 * @returns Merkle path with siblings and path indices
 */
export function computeMerklePath(
  leaves: Uint8Array[],
  leafIndex: number,
  depth: number = DEFAULT_TREE_DEPTH
): MerklePath {
  const capacity = 2 ** depth;
  const paddedLeaves = [...leaves];
  while (paddedLeaves.length < capacity) {
    paddedLeaves.push(ZERO_VALUE);
  }

  const siblings: Uint8Array[] = [];
  const pathIndices: number[] = [];

  let currentLevel = paddedLeaves;
  let currentIndex = leafIndex;

  for (let level = 0; level < depth; level++) {
    const siblingIndex = currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;
    pathIndices.push(currentIndex % 2);
    siblings.push(currentLevel[siblingIndex] || ZERO_VALUE);

    // Move to the next level
    const nextLevel: Uint8Array[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = currentLevel[i + 1] || ZERO_VALUE;
      nextLevel.push(hashPair(left, right));
    }
    currentLevel = nextLevel;
    currentIndex = Math.floor(currentIndex / 2);
  }

  return { siblings, pathIndices };
}

/**
 * Verifies a Merkle path against a root.
 * @param root - Expected root hash
 * @param leaf - Leaf hash
 * @param path - Merkle path
 * @returns True if the path is valid
 */
export function verifyMerklePath(
  root: Uint8Array,
  leaf: Uint8Array,
  path: MerklePath
): boolean {
  let currentHash = leaf;

  for (let i = 0; i < path.siblings.length; i++) {
    if (path.pathIndices[i] === 0) {
      currentHash = hashPair(currentHash, path.siblings[i]);
    } else {
      currentHash = hashPair(path.siblings[i], currentHash);
    }
  }

  // Compare with root
  if (currentHash.length !== root.length) return false;
  let equal = true;
  for (let j = 0; j < currentHash.length; j++) {
    if (currentHash[j] !== root[j]) {
      equal = false;
      break;
    }
  }
  return equal;
}

/**
 * Hashes two sibling nodes together to produce a parent node.
 * @param left - Left child hash
 * @param right - Right child hash
 * @returns Parent hash
 */
export function hashPair(left: Uint8Array, right: Uint8Array): Uint8Array {
  const input = Buffer.concat([
    Buffer.from("kirite-merkle-v1"),
    Buffer.from(left),
    Buffer.from(right),
  ]);
  return hash256(input);
}

/**
 * Computes the leaf hash for a deposit commitment.
 * @param commitment - Deposit commitment
 * @returns Leaf hash
 */
export function computeLeafHash(commitment: Uint8Array): Uint8Array {
  const input = Buffer.concat([
    Buffer.from("kirite-leaf-v1"),
    Buffer.from(commitment),
  ]);
  return hash256(input);
}

/**
 * Gets the zero hashes for each level of the tree.
 * Used for efficient tree construction.
 * @param depth - Tree depth
 * @returns Array of zero hashes, one per level
 */
export function getZeroHashes(depth: number): Uint8Array[] {
  const zeroHashes: Uint8Array[] = [ZERO_VALUE];

  for (let i = 1; i <= depth; i++) {
    zeroHashes.push(hashPair(zeroHashes[i - 1], zeroHashes[i - 1]));
  }

  return zeroHashes;
}
