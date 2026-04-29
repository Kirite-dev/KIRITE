/**
 * Relayer e2e test: deposit -> generate Groth16 proof -> POST to relayer -> verify recipient got funds.
 *
 * Tests that:
 *   1. SDK can build a deposit ix and land it on devnet.
 *   2. Client can fetch pool state, scan leaves, build the proof.
 *   3. relayer.kirite.dev /api/withdraw-v3 accepts the proof.
 *   4. Relayer submits the on-chain withdraw and the recipient ATA balance increases.
 *
 * Usage:
 *   SCAN_RPC_URL=https://devnet.helius-rpc.com/?api-key=... \
 *   RELAYER_URL=https://relayer.kirite.dev \
 *   node scripts/test-relayer-e2e.mjs
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
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
  buildInitializeProtocolIx,
  buildInitializeShieldPoolIx,
  buildDepositIx,
  buildComputeUnitLimitIx,
  decodeShieldPool,
  fetchPoolLeaves,
} from "../sdk/src/kirite-zk.mjs";
import {
  computeCommitment,
  generateMembershipProof,
  randomFieldBytes,
} from "../sdk/src/zk.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DENOM = 12_345_678n;
const TIMELOCK = 600n;
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const SCAN_RPC_URL = process.env.SCAN_RPC_URL || RPC_URL;
const RELAYER_URL = process.env.RELAYER_URL || "https://relayer.kirite.dev";

const WASM = path.resolve(__dirname, "../circuits/build/membership_js/membership.wasm");
const ZKEY = path.resolve(__dirname, "../circuits/build/membership_final.zkey");

function loadKp() {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8"))),
  );
}

function bytesToHex(b) {
  return Buffer.from(b).toString("hex");
}

async function ensureProtocol(conn, payer) {
  const [config] = deriveProtocolConfig();
  if (await conn.getAccountInfo(config)) return;
  const ix = buildInitializeProtocolIx({
    authority: payer.publicKey,
    treasury: payer.publicKey,
  });
  const sig = await conn.sendTransaction(new Transaction().add(ix), [payer]);
  await conn.confirmTransaction(sig, "confirmed");
}

async function ensurePool(conn, payer) {
  const [pool] = deriveShieldPool(NATIVE_MINT, DENOM);
  const [vAuth] = deriveVaultAuthority(pool);
  const vault = await getAssociatedTokenAddress(NATIVE_MINT, vAuth, true);
  if (!(await conn.getAccountInfo(pool))) {
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, vault, vAuth, NATIVE_MINT,
    );
    await conn.confirmTransaction(
      await conn.sendTransaction(new Transaction().add(ataIx), [payer]),
      "confirmed",
    );
    const ix = buildInitializeShieldPoolIx({
      operator: payer.publicKey,
      mint: NATIVE_MINT,
      vault,
      denomination: DENOM,
      timelockSeconds: TIMELOCK,
    });
    await conn.confirmTransaction(
      await conn.sendTransaction(new Transaction().add(ix), [payer]),
      "confirmed",
    );
  }
  return { pool, vault };
}

async function depositOnce(conn, payer, pool, vault) {
  const ata = await getAssociatedTokenAddress(NATIVE_MINT, payer.publicKey);
  const wrapTx = new Transaction()
    .add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey, ata, payer.publicKey, NATIVE_MINT,
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

  const poolState = decodeShieldPool((await conn.getAccountInfo(pool)).data);
  const leafIndex = poolState.nextLeafIndex;
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
    [payer],
  );
  await conn.confirmTransaction(sig, "confirmed");
  return { ns, bf, leafIndex, commitment, sig };
}

async function main() {
  const start = Date.now();
  console.log("KIRITE relayer e2e");
  console.log("==================");
  console.log(`relayer:  ${RELAYER_URL}`);

  console.log("[1/6] relayer health");
  const health = await fetch(`${RELAYER_URL}/api/health`).then((r) => r.json());
  console.log(`  status: ${health.status}, balance: ${health.balanceSol} SOL`);
  if (!["ok", "warn"].includes(health.status)) {
    throw new Error(`relayer unhealthy: ${health.status}`);
  }

  const conn = new Connection(RPC_URL, "confirmed");
  const scanConn = SCAN_RPC_URL === RPC_URL ? conn : new Connection(SCAN_RPC_URL, "confirmed");
  const payer = loadKp();
  console.log(`[2/6] payer: ${payer.publicKey.toBase58()}`);

  await ensureProtocol(conn, payer);
  const { pool, vault } = await ensurePool(conn, payer);
  console.log(`  pool: ${pool.toBase58()}`);

  console.log("[3/6] deposit");
  const note = await depositOnce(conn, payer, pool, vault);
  console.log(`  leaf=${note.leafIndex}, sig=${note.sig.slice(0, 32)}...`);

  console.log("[4/6] generate Groth16 proof");
  // Final recipient is a fresh stealth address. The relayer takes the
  // unwrapped SOL and System.transfers it there atomically.
  const recipientKp = Keypair.generate();
  // The proof binds to the RELAYER's WSOL ATA (the on-chain recipient
  // of the withdraw ix), not the final stealth address. The relayer
  // unwraps and forwards via SystemProgram.transfer afterwards.
  const relayerPubkey = new PublicKey(health.relayer);
  const relayerWsolAta = await getAssociatedTokenAddress(NATIVE_MINT, relayerPubkey);
  console.log(`  relayer WSOL ATA: ${relayerWsolAta.toBase58()}`);

  const allLeaves = await fetchPoolLeaves(scanConn, pool, { limit: 1000 });
  console.log(`  recovered ${allLeaves.length} leaves`);

  const t0 = Date.now();
  const { proof, publicInputs } = await generateMembershipProof({
    nullifierSecret: note.ns,
    blindingFactor: note.bf,
    amount: DENOM,
    leafIndex: note.leafIndex,
    allLeaves,
    recipient: relayerWsolAta,
    wasmPath: WASM,
    zkeyPath: ZKEY,
  });
  console.log(`  proof gen: ${Date.now() - t0}ms`);

  console.log("[5/6] POST proof to relayer");
  const relayBody = {
    proofHex: bytesToHex(proof),
    nullifierHashHex: bytesToHex(publicInputs.nullifierHash),
    proofRootHex: bytesToHex(publicInputs.root),
    stealthPubkey: recipientKp.publicKey.toBase58(),
    mint: NATIVE_MINT.toBase58(),
    denomLamports: DENOM.toString(),
  };
  const t1 = Date.now();
  const relayResp = await fetch(`${RELAYER_URL}/api/withdraw-v3`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(relayBody),
  });
  const relayMs = Date.now() - t1;
  const relayJson = await relayResp.json();
  console.log(`  relayer responded in ${relayMs}ms, status=${relayResp.status}`);
  console.log(`  body: ${JSON.stringify(relayJson).slice(0, 200)}`);
  if (!relayResp.ok) {
    throw new Error(`relayer rejected: ${JSON.stringify(relayJson)}`);
  }

  console.log("[6/6] verify recipient got funds");
  if (relayJson.signature) {
    await conn.confirmTransaction(relayJson.signature, "confirmed");
  } else {
    await new Promise((r) => setTimeout(r, 5000));
  }
  // Stealth recipient gets unwrapped SOL via System.transfer (no ATA).
  const after = await conn.getBalance(recipientKp.publicKey);
  console.log(`  recipient SOL balance: ${after} lamports`);

  if (BigInt(after) === 0n) {
    throw new Error("recipient SOL balance is still zero");
  }

  console.log("\n================== ");
  console.log(`✓ relayer e2e succeeded in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log(`  withdraw sig: ${relayJson.signature ?? "(unknown)"}`);
}

main().catch((e) => {
  console.error("\n✗ relayer e2e failed:", e.message ?? e);
  process.exit(1);
});
