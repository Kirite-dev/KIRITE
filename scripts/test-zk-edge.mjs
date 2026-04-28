/**
 * KIRITE privacy v3 — edge-case test suite (devnet).
 *
 * Walks through the failure modes the on-chain verifier and Anchor
 * constraints should reject. Each case is a discrete sub-test that logs
 * pass/fail. Exit code is non-zero if any case fails.
 *
 * Cases:
 *   1. valid happy-path (sanity)
 *   2. wrong recipient → proof rejected (recipient_hash binding)
 *   3. tampered proof byte → proof rejected
 *   4. wrong root not in known_roots → InvalidMerkleProof
 *   5. double-spend (replay same nullifier) → init account collision
 *   6. concurrent deposits land at correct leaf indices and tree updates
 *   7. pool capacity (32-cap) — soft check via decoded pool counter
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAccount,
} from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  KIRITE_PROGRAM_ID,
  deriveShieldPool,
  deriveVaultAuthority,
  deriveProtocolConfig,
  deriveNullifierRecord,
  buildInitializeProtocolIx,
  buildInitializeShieldPoolIx,
  buildDepositIx,
  buildWithdrawIx,
  buildComputeUnitLimitIx,
  decodeShieldPool,
  fetchPoolLeaves,
} from "../sdk/src/kirite-zk.mjs";
import {
  computeCommitment,
  generateMembershipProof,
  randomFieldBytes,
  pubkeyToField,
} from "../sdk/src/zk.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DENOM = 12_345_678n; // matches the height-15 verified pool used by test-zk-e2e
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const SCAN_RPC_URL = process.env.SCAN_RPC_URL || RPC_URL;
const WASM = path.resolve(__dirname, "../circuits/build/membership_js/membership.wasm");
const ZKEY = path.resolve(__dirname, "../circuits/build/membership_final.zkey");

let pass = 0;
let fail = 0;
const failures = [];

function loadKp(p = `${os.homedir()}/.config/solana/id.json`) {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))),
  );
}

function ok(name) {
  console.log(`  ✓ ${name}`);
  pass++;
}
function ko(name, err) {
  console.log(`  ✗ ${name} — ${err?.message || err}`);
  fail++;
  failures.push({ name, err: err?.message || String(err) });
}

async function deposit(conn, payer, pool, vault, leafIndex) {
  const ata = await getAssociatedTokenAddress(NATIVE_MINT, payer.publicKey);
  const wrapTx = new Transaction();
  wrapTx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      ata,
      payer.publicKey,
      NATIVE_MINT,
    ),
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: ata,
      lamports: Number(DENOM),
    }),
    createSyncNativeInstruction(ata),
  );
  await conn.confirmTransaction(
    await conn.sendTransaction(wrapTx, [payer]),
    "confirmed",
  );

  const ns = randomFieldBytes();
  const bf = randomFieldBytes();
  const commitment = await computeCommitment(ns, DENOM, bf, leafIndex);

  const ix = buildDepositIx({
    depositor: payer.publicKey,
    depositorTokenAccount: ata,
    vault,
    shieldPool: pool,
    commitment,
  });
  const sig = await conn.sendTransaction(
    new Transaction().add(buildComputeUnitLimitIx(600_000), ix),
    [payer]
  );
  await conn.confirmTransaction(sig, "confirmed");
  return { ns, bf, leafIndex, commitment, sig };
}

async function buildProofFor(conn, scanConn, pool, note, recipientAtaPubkey) {
  const allLeaves = await fetchPoolLeaves(scanConn, pool, { limit: 1000 });
  return generateMembershipProof({
    nullifierSecret: note.ns,
    blindingFactor: note.bf,
    amount: DENOM,
    leafIndex: note.leafIndex,
    allLeaves,
    recipient: recipientAtaPubkey,
    wasmPath: WASM,
    zkeyPath: ZKEY,
  });
}

async function submitWithdraw(conn, payer, pool, vault, recipientAta, treasuryAta, proof, publicInputs) {
  const ix = buildWithdrawIx({
    relayer: payer.publicKey,
    recipientTokenAccount: recipientAta,
    treasuryTokenAccount: treasuryAta,
    mint: NATIVE_MINT,
    shieldPool: pool,
    vault,
    proof,
    nullifierHash: publicInputs.nullifierHash,
    proofRoot: publicInputs.root,
  });
  const sig = await conn.sendTransaction(
    new Transaction().add(buildComputeUnitLimitIx(600_000), ix),
    [payer]
  );
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

async function ensureRecipient(conn, payer) {
  const recipient = Keypair.generate();
  const ata = await getAssociatedTokenAddress(NATIVE_MINT, recipient.publicKey);
  const ix = createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey, ata, recipient.publicKey, NATIVE_MINT,
  );
  await conn.confirmTransaction(
    await conn.sendTransaction(new Transaction().add(ix), [payer]),
    "confirmed",
  );
  return { keypair: recipient, ata };
}

async function main() {
  console.log("KIRITE v3 edge-case suite");
  console.log("=========================\n");

  const conn = new Connection(RPC_URL, "confirmed");
  const scanConn = SCAN_RPC_URL === RPC_URL ? conn : new Connection(SCAN_RPC_URL, "confirmed");
  const payer = loadKp();
  console.log("payer:   ", payer.publicKey.toBase58());
  console.log("program: ", KIRITE_PROGRAM_ID.toBase58());

  const [pool] = deriveShieldPool(NATIVE_MINT, DENOM);
  const [vaultAuthority] = deriveVaultAuthority(pool);
  const vault = await getAssociatedTokenAddress(NATIVE_MINT, vaultAuthority, true);
  const treasuryAta = await getAssociatedTokenAddress(NATIVE_MINT, payer.publicKey);

  // Initial state (use whatever leaf_index is next).
  let poolInfo = await conn.getAccountInfo(pool);
  let decoded = decodeShieldPool(poolInfo.data);
  let leafIdx = decoded.nextLeafIndex;
  console.log("starting leaf_index:", leafIdx, "\n");

  // ── Case 1: happy path ───────────────────────────────────────────
  console.log("[1] valid happy-path");
  let happyNote;
  try {
    happyNote = await deposit(conn, payer, pool, vault, leafIdx);
    leafIdx++;
    const recipient = await ensureRecipient(conn, payer);
    const { proof, publicInputs } = await buildProofFor(conn, scanConn, pool, happyNote, recipient.ata);
    await submitWithdraw(conn, payer, pool, vault, recipient.ata, treasuryAta, proof, publicInputs);
    const acc = await getAccount(conn, recipient.ata);
    if (acc.amount === 0n) throw new Error("recipient got nothing");
    ok("happy-path withdraw landed " + acc.amount + " lamports");
  } catch (e) {
    ko("happy-path", e);
  }

  // ── Case 2: wrong recipient binding ──────────────────────────────
  console.log("\n[2] wrong recipient binding (proof should be rejected)");
  try {
    const note = await deposit(conn, payer, pool, vault, leafIdx);
    leafIdx++;
    const realRecipient = await ensureRecipient(conn, payer);
    const fakeRecipient = await ensureRecipient(conn, payer);

    // Generate the proof bound to fakeRecipient, then try to use it
    // with realRecipient. The on-chain verifier recomputes
    // recipient_hash from the actual recipient and rejects.
    const { proof, publicInputs } = await buildProofFor(conn, scanConn, pool, note, fakeRecipient.ata);
    try {
      await submitWithdraw(conn, payer, pool, vault, realRecipient.ata, treasuryAta, proof, publicInputs);
      ko("wrong-recipient was accepted (should reject)");
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("InvalidAmountProof") || msg.includes("0x1788") || msg.includes("custom program error")) {
        ok("wrong-recipient correctly rejected");
      } else {
        ko("wrong-recipient: unexpected error", e);
      }
    }
  } catch (e) {
    ko("wrong-recipient setup failed", e);
  }

  // ── Case 3: tampered proof byte ──────────────────────────────────
  console.log("\n[3] tampered proof byte (verifier should reject)");
  try {
    const note = await deposit(conn, payer, pool, vault, leafIdx);
    leafIdx++;
    const recipient = await ensureRecipient(conn, payer);
    const { proof, publicInputs } = await buildProofFor(conn, scanConn, pool, note, recipient.ata);
    const tampered = new Uint8Array(proof);
    tampered[0] ^= 0x01; // flip a bit in proof_a
    try {
      await submitWithdraw(conn, payer, pool, vault, recipient.ata, treasuryAta, tampered, publicInputs);
      ko("tampered proof was accepted (should reject)");
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("InvalidAmountProof") || msg.includes("custom program error")) {
        ok("tampered proof correctly rejected");
      } else {
        ko("tampered proof: unexpected error", e);
      }
    }

    // Recover: actually withdraw with the valid proof so this leaf
    // doesn't sit unspent forever.
    const { proof: cleanProof, publicInputs: cleanPub } = await buildProofFor(conn, scanConn, pool, note, recipient.ata);
    await submitWithdraw(conn, payer, pool, vault, recipient.ata, treasuryAta, cleanProof, cleanPub);
  } catch (e) {
    ko("tampered proof setup failed", e);
  }

  // ── Case 4: unknown root ─────────────────────────────────────────
  console.log("\n[4] unknown root (proof_root not in known_roots)");
  try {
    const note = await deposit(conn, payer, pool, vault, leafIdx);
    leafIdx++;
    const recipient = await ensureRecipient(conn, payer);
    const { proof, publicInputs } = await buildProofFor(conn, scanConn, pool, note, recipient.ata);
    const fakeRoot = new Uint8Array(32);
    fakeRoot[0] = 0xab; fakeRoot[31] = 0xcd; // not in pool's root history
    try {
      await submitWithdraw(conn, payer, pool, vault, recipient.ata, treasuryAta, proof, {
        ...publicInputs,
        root: fakeRoot,
      });
      ko("unknown root was accepted");
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("InvalidMerkleProof") || msg.includes("0x1782") || msg.includes("custom program error")) {
        ok("unknown root correctly rejected");
      } else {
        ko("unknown root: unexpected error", e);
      }
    }
    // Recover the leaf with valid root
    const { proof: ok2, publicInputs: pi2 } = await buildProofFor(conn, scanConn, pool, note, recipient.ata);
    await submitWithdraw(conn, payer, pool, vault, recipient.ata, treasuryAta, ok2, pi2);
  } catch (e) {
    ko("unknown root setup failed", e);
  }

  // ── Case 5: double-spend (replay nullifier) ──────────────────────
  console.log("\n[5] double-spend (replay nullifier — PDA init must collide)");
  try {
    const note = await deposit(conn, payer, pool, vault, leafIdx);
    leafIdx++;
    const recipient = await ensureRecipient(conn, payer);
    const { proof, publicInputs } = await buildProofFor(conn, scanConn, pool, note, recipient.ata);
    await submitWithdraw(conn, payer, pool, vault, recipient.ata, treasuryAta, proof, publicInputs);

    // Second withdraw with same nullifier_hash → nullifier_record PDA
    // already exists → `init` reverts.
    try {
      const recipient2 = await ensureRecipient(conn, payer);
      const { proof: p2, publicInputs: pi2 } = await buildProofFor(conn, scanConn, pool, note, recipient2.ata);
      await submitWithdraw(conn, payer, pool, vault, recipient2.ata, treasuryAta, p2, pi2);
      ko("double-spend was accepted");
    } catch (e) {
      const msg = String(e?.message || e);
      // anchor `init` collision shows up as either custom err 0
      // (TryFrom on the PDA) or the system program "already in use".
      if (msg.includes("already in use") ||
          msg.includes("0x0") ||
          msg.includes("custom program error") ||
          msg.includes("AccountAlreadyInitialized")) {
        ok("double-spend correctly rejected (PDA collision)");
      } else {
        ko("double-spend: unexpected error", e);
      }
    }
  } catch (e) {
    ko("double-spend setup failed", e);
  }

  // ── Case 6: tree state consistency after multi-deposit ───────────
  console.log("\n[6] tree state consistency across rapid deposits");
  try {
    const before = decodeShieldPool((await conn.getAccountInfo(pool)).data);
    const baseIdx = before.nextLeafIndex;
    const n1 = await deposit(conn, payer, pool, vault, baseIdx);
    const n2 = await deposit(conn, payer, pool, vault, baseIdx + 1);
    const after = decodeShieldPool((await conn.getAccountInfo(pool)).data);
    if (after.nextLeafIndex !== baseIdx + 2) {
      throw new Error(`nextLeafIndex expected ${baseIdx + 2} got ${after.nextLeafIndex}`);
    }

    // Both leaves recoverable via withdraw.
    const r1 = await ensureRecipient(conn, payer);
    const r2 = await ensureRecipient(conn, payer);
    const { proof: p1, publicInputs: pi1 } = await buildProofFor(conn, scanConn, pool, n1, r1.ata);
    await submitWithdraw(conn, payer, pool, vault, r1.ata, treasuryAta, p1, pi1);
    const { proof: p2, publicInputs: pi2 } = await buildProofFor(conn, scanConn, pool, n2, r2.ata);
    await submitWithdraw(conn, payer, pool, vault, r2.ata, treasuryAta, p2, pi2);

    leafIdx = baseIdx + 2;
    ok(`tree consistent after 2 sequential deposits + withdraws`);
  } catch (e) {
    ko("tree consistency", e);
  }

  // ── Case 7: pool capacity counter ────────────────────────────────
  console.log("\n[7] pool capacity counter readable");
  try {
    const final = decodeShieldPool((await conn.getAccountInfo(pool)).data);
    console.log(`    nextLeafIndex=${final.nextLeafIndex}, totalDeposits=${final.totalDeposits}, totalWithdrawals=${final.totalWithdrawals}`);
    if (final.nextLeafIndex >= 32_768) {
      console.log("    ⚠ pool is at capacity — next deposit should fail with PoolCapacityExceeded");
    }
    ok("pool counters readable");
  } catch (e) {
    ko("pool counters", e);
  }

  console.log("\n=========================");
  console.log(`PASS: ${pass}  FAIL: ${fail}`);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
