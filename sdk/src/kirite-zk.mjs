// KIRITE privacy v3 SDK — manual ix encoding, no IDL.
//
// Mirrors the on-chain layout in `programs/kirite/src/lib.rs` for the
// v3 ZK build. Everything privacy-related (deposit + withdraw) goes
// through this SDK so the proof generator and the on-chain verifier
// stay in lockstep.

import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createHash } from "node:crypto";

export const KIRITE_PROGRAM_ID = new PublicKey(
  "FjYwYT9PDcW2UmM2siXpURjSSCDoXTvviqb3V8amzusL",
);

function disc(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function u16Le(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u64Le(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

function i64Le(n) {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
}

export function deriveProtocolConfig() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    KIRITE_PROGRAM_ID,
  );
}

export function deriveGovernance(protocolConfig) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("governance"), protocolConfig.toBuffer()],
    KIRITE_PROGRAM_ID,
  );
}

export function deriveShieldPool(mint, denomination) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("shield_pool"),
      mint.toBuffer(),
      u64Le(denomination),
    ],
    KIRITE_PROGRAM_ID,
  );
}

export function deriveVaultAuthority(pool) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority"), pool.toBuffer()],
    KIRITE_PROGRAM_ID,
  );
}

export function deriveNullifierRecord(pool, nullifierHash) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), pool.toBuffer(), Buffer.from(nullifierHash)],
    KIRITE_PROGRAM_ID,
  );
}

// ─── Instruction builders ─────────────────────────────────────────────

export function buildInitializeProtocolIx({
  authority,
  treasury,
  feeBps,
  burnRatioBps,
}) {
  const [protocolConfig] = deriveProtocolConfig();
  const [governance] = deriveGovernance(protocolConfig);

  const data = Buffer.concat([
    disc("initialize_protocol"),
    u16Le(feeBps),
    u16Le(burnRatioBps),
  ]);

  return new TransactionInstruction({
    programId: KIRITE_PROGRAM_ID,
    keys: [
      { pubkey: protocolConfig, isSigner: false, isWritable: true },
      { pubkey: governance, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildInitializeShieldPoolIx({
  operator,
  mint,
  vault,
  denomination,
  timelockSeconds,
}) {
  const [shieldPool] = deriveShieldPool(mint, denomination);
  const [protocolConfig] = deriveProtocolConfig();

  const data = Buffer.concat([
    disc("initialize_shield_pool"),
    u64Le(denomination),
    i64Le(timelockSeconds),
  ]);

  return new TransactionInstruction({
    programId: KIRITE_PROGRAM_ID,
    keys: [
      { pubkey: shieldPool, isSigner: false, isWritable: true },
      { pubkey: protocolConfig, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: operator, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildDepositIx({
  depositor,
  depositorTokenAccount,
  vault,
  shieldPool,
  commitment,
}) {
  const [protocolConfig] = deriveProtocolConfig();

  const data = Buffer.concat([disc("deposit"), Buffer.from(commitment)]);

  return new TransactionInstruction({
    programId: KIRITE_PROGRAM_ID,
    keys: [
      { pubkey: shieldPool, isSigner: false, isWritable: true },
      { pubkey: protocolConfig, isSigner: false, isWritable: false },
      { pubkey: depositorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: depositor, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildWithdrawIx({
  relayer,
  recipientTokenAccount,
  treasuryTokenAccount,
  mint,
  shieldPool,
  vault,
  proof,
  nullifierHash,
  proofRoot,
}) {
  const [protocolConfig] = deriveProtocolConfig();
  const [vaultAuthority] = deriveVaultAuthority(shieldPool);
  const [nullifierRecord] = deriveNullifierRecord(shieldPool, nullifierHash);

  const data = Buffer.concat([
    disc("withdraw"),
    Buffer.from(proof),
    Buffer.from(nullifierHash),
    Buffer.from(proofRoot),
  ]);

  return new TransactionInstruction({
    programId: KIRITE_PROGRAM_ID,
    keys: [
      { pubkey: shieldPool, isSigner: false, isWritable: true },
      { pubkey: protocolConfig, isSigner: false, isWritable: false },
      { pubkey: nullifierRecord, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
      { pubkey: treasuryTokenAccount, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: relayer, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─── Event scanner ────────────────────────────────────────────────────
//
// The on-chain pool stores a compact tree (filled_subtrees + roots) but
// not the leaves themselves. Clients that need to generate Merkle
// proofs must rebuild the leaf list by replaying deposit events from
// the program's log history.

const DEPOSIT_EVENT_DISC = createHash("sha256")
  .update("event:DepositCommitted")
  .digest()
  .subarray(0, 8);

function decodeDepositEvent(buf) {
  // Layout (Borsh, after 8-byte discriminator):
  //   pool: Pubkey (32)
  //   depositor: Pubkey (32)
  //   commitment_hash: [u8; 32]
  //   encrypted_amount: [u8; 64]
  //   leaf_index: u32
  //   timestamp: i64
  let o = 8;
  const slice = (n) => {
    const v = buf.subarray(o, o + n);
    o += n;
    return v;
  };
  const pool = new PublicKey(slice(32));
  const depositor = new PublicKey(slice(32));
  const commitment = Uint8Array.from(slice(32));
  o += 64; // skip encrypted_amount (unused)
  const leafIndex = buf.readUInt32LE(o);
  o += 4;
  const timestamp = Number(buf.readBigInt64LE(o));
  return { pool, depositor, commitment, leafIndex, timestamp };
}

/**
 * Walk the program's recent signature history, decode every
 * DepositCommitted event for the given pool, and return them sorted
 * by leaf_index.
 */
export async function fetchPoolLeaves(connection, poolKey, options = {}) {
  const limit = options.limit ?? 1000;
  const sigs = await connection.getSignaturesForAddress(KIRITE_PROGRAM_ID, {
    limit,
  });

  const leaves = new Map(); // leaf_index → commitment

  for (const sigInfo of sigs) {
    if (sigInfo.err) continue;
    const tx = await connection.getTransaction(sigInfo.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta?.logMessages) continue;

    for (const line of tx.meta.logMessages) {
      const m = /^Program data: (.+)$/.exec(line);
      if (!m) continue;
      const data = Buffer.from(m[1], "base64");
      if (data.length < 8) continue;
      if (Buffer.compare(data.subarray(0, 8), DEPOSIT_EVENT_DISC) !== 0) {
        continue;
      }
      try {
        const evt = decodeDepositEvent(data);
        if (evt.pool.equals(poolKey)) {
          leaves.set(evt.leafIndex, evt.commitment);
        }
      } catch {
        // malformed log; skip
      }
    }
  }

  // Materialize in leaf_index order.
  const out = [];
  const maxIdx = Math.max(-1, ...leaves.keys());
  for (let i = 0; i <= maxIdx; i++) {
    out[i] = leaves.get(i);
  }
  return out;
}

// ─── Account decoders ─────────────────────────────────────────────────

const MAX_HISTORICAL_ROOTS = 3;
const MERKLE_TREE_HEIGHT = 5;

/**
 * Decode a ShieldPool account (#[account(zero_copy)]).
 * Layout matches `programs/kirite/src/state/shield_pool.rs`.
 *   [0..8]    discriminator
 *   [8..40]   mint
 *   [40..72]  operator
 *   [72..104] protocol_config
 *   [104..136] vault
 *   [136..168] current_root
 *   [168..264] historical_roots[3]    (32*3)
 *   [264..424] filled_subtrees[5]     (32*5)
 *   [424..432] denomination u64
 *   [432..440] total_deposits u64
 *   [440..448] total_withdrawals u64
 *   [448..456] fees_collected u64
 *   [456..464] timelock_seconds i64
 *   [464..472] created_at i64
 *   [472..480] last_deposit_at i64
 *   [480..484] next_leaf_index u32
 *   [484]     root_history_index u8
 *   [485]     is_frozen u8
 *   [486]     bump u8
 *   [487]     vault_authority_bump u8
 */
export function decodeShieldPool(buf) {
  let o = 8;
  const read32 = () => {
    const v = new PublicKey(buf.subarray(o, o + 32));
    o += 32;
    return v;
  };
  const read32Bytes = () => {
    const v = Uint8Array.from(buf.subarray(o, o + 32));
    o += 32;
    return v;
  };
  const readU64 = () => {
    const v = buf.readBigUInt64LE(o);
    o += 8;
    return v;
  };
  const readI64 = () => {
    const v = buf.readBigInt64LE(o);
    o += 8;
    return v;
  };
  const readU32 = () => {
    const v = buf.readUInt32LE(o);
    o += 4;
    return v;
  };
  const readU8 = () => {
    const v = buf.readUInt8(o);
    o += 1;
    return v;
  };

  const out = {
    mint: read32(),
    operator: read32(),
    protocolConfig: read32(),
    vault: read32(),
    currentRoot: read32Bytes(),
    historicalRoots: [],
    filledSubtrees: [],
  };
  for (let i = 0; i < MAX_HISTORICAL_ROOTS; i++) out.historicalRoots.push(read32Bytes());
  for (let i = 0; i < MERKLE_TREE_HEIGHT; i++) out.filledSubtrees.push(read32Bytes());

  out.denomination = readU64();
  out.totalDeposits = readU64();
  out.totalWithdrawals = readU64();
  out.feesCollected = readU64();
  out.timelockSeconds = readI64();
  out.createdAt = readI64();
  out.lastDepositAt = readI64();
  out.nextLeafIndex = readU32();
  out.rootHistoryIndex = readU8();
  out.isFrozen = readU8();
  out.bump = readU8();
  out.vaultAuthorityBump = readU8();
  return out;
}
