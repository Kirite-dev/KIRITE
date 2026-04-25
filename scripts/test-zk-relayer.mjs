/**
 * Devnet smoke test: real production round-trip.
 *
 *   browser (deployed miniapp) → deployed relayer → on-chain verifier → recipient ATA
 *
 * Catches anything that the local CLI tests can mask: relayer cold-start,
 * env config, deployed wasm/zkey integrity, fetch CORS, and the actual
 * /api/withdraw-v3 handler against a freshly-funded leaf.
 */

import { chromium } from "playwright-core";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
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

import {
  deriveShieldPool,
  deriveVaultAuthority,
  buildDepositIx,
  decodeShieldPool,
  fetchPoolLeaves,
} from "../sdk/src/kirite-zk.mjs";
import { computeCommitment, randomFieldBytes } from "../sdk/src/zk.mjs";

const DENOM = 5_000_000n;
const RPC = process.env.RPC_URL || "https://devnet.helius-rpc.com/?api-key=8fc70926-95dc-4e72-8557-7245bd7e36fa";
const MINIAPP_URL = process.env.MINIAPP_URL || "https://kirite-tg.vercel.app";
const RELAYER_URL = process.env.RELAYER_URL || "https://kirite-relayer.vercel.app";

function loadKp() {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf-8"))),
  );
}

async function main() {
  console.log("kirite v3 production round-trip");
  console.log("===============================");
  console.log("rpc:    ", RPC.replace(/api-key=.*/, "api-key=***"));
  console.log("miniapp:", MINIAPP_URL);
  console.log("relayer:", RELAYER_URL);
  console.log();

  const conn = new Connection(RPC, "confirmed");
  const payer = loadKp();
  console.log("payer:", payer.publicKey.toBase58());

  const [pool] = deriveShieldPool(NATIVE_MINT, DENOM);
  const [vaultAuthority] = deriveVaultAuthority(pool);
  const vault = await getAssociatedTokenAddress(NATIVE_MINT, vaultAuthority, true);

  // 1. wrap + deposit
  console.log("\n[1] deposit fresh leaf");
  const ata = await getAssociatedTokenAddress(NATIVE_MINT, payer.publicKey);
  const wrapTx = new Transaction();
  wrapTx.add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, payer.publicKey, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ata, lamports: Number(DENOM) }),
    createSyncNativeInstruction(ata),
  );
  await conn.confirmTransaction(await conn.sendTransaction(wrapTx, [payer]), "confirmed");

  const decoded = decodeShieldPool((await conn.getAccountInfo(pool)).data);
  const leafIndex = decoded.nextLeafIndex;
  const ns = randomFieldBytes();
  const bf = randomFieldBytes();
  const commitment = await computeCommitment(ns, DENOM, bf, leafIndex);

  const sig = await conn.sendTransaction(
    new Transaction().add(buildDepositIx({
      depositor: payer.publicKey,
      depositorTokenAccount: ata,
      vault,
      shieldPool: pool,
      commitment,
    })),
    [payer],
  );
  await conn.confirmTransaction(sig, "confirmed");
  console.log(`  leaf=${leafIndex} sig=${sig}`);

  // 2. fetch the relayer's pubkey (so the proof binds to the relayer's WSOL ATA)
  console.log("\n[2] fetch relayer pubkey from /api/health");
  const health = await fetch(RELAYER_URL + "/api/health").then(r => r.json());
  if (!health.relayer) throw new Error("relayer health missing pubkey");
  const relayerPub = new PublicKey(health.relayer);
  const relayerWsolAta = await getAssociatedTokenAddress(NATIVE_MINT, relayerPub);
  console.log(`  relayer:      ${relayerPub.toBase58()}`);
  console.log(`  relayer WSOL: ${relayerWsolAta.toBase58()}`);

  // 3. spin up browser, generate proof bound to relayer WSOL ATA
  console.log("\n[3] generate proof in deployed miniapp");
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  await page.goto(MINIAPP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(() => !!window.KZK, { timeout: 30_000 });

  const allLeaves = await fetchPoolLeaves(conn, pool, { limit: 1000 });
  const t0 = Date.now();
  const result = await page.evaluate(async (input) => {
    const KZK = window.KZK;
    await KZK.warmUp();
    const r = await KZK.generateMembershipProof({
      nullifierSecret: new Uint8Array(input.ns),
      blindingFactor: new Uint8Array(input.bf),
      amount: BigInt(input.amount),
      leafIndex: input.leafIndex,
      allLeaves: input.leaves.map(b => b ? new Uint8Array(b) : null),
      recipientPubkey: new Uint8Array(input.recipient),
    });
    return {
      proofHex: KZK.bytesToHex(r.proof),
      nullifierHashHex: KZK.bytesToHex(r.publicInputs.nullifierHash),
      proofRootHex: KZK.bytesToHex(r.publicInputs.root),
    };
  }, {
    ns: Array.from(ns),
    bf: Array.from(bf),
    amount: DENOM.toString(),
    leafIndex,
    leaves: allLeaves.map(l => l ? Array.from(l) : null),
    recipient: Array.from(relayerWsolAta.toBytes()),
  });
  await browser.close();
  console.log(`  proof gen: ${Date.now() - t0}ms`);

  // 4. POST to deployed relayer
  console.log("\n[4] POST /api/withdraw-v3 to deployed relayer");
  const stealth = Keypair.generate();
  const reqBody = {
    proofHex: result.proofHex,
    nullifierHashHex: result.nullifierHashHex,
    proofRootHex: result.proofRootHex,
    stealthPubkey: stealth.publicKey.toBase58(),
    denomLamports: DENOM.toString(),
    mint: NATIVE_MINT.toBase58(),
  };
  const t1 = Date.now();
  const res = await fetch(RELAYER_URL + "/api/withdraw-v3", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reqBody),
  });
  const body = await res.json();
  console.log(`  http ${res.status} (${Date.now() - t1}ms)`);
  console.log(`  body:`, JSON.stringify(body, null, 2));

  if (!res.ok || body.status !== "sent") {
    throw new Error("relayer rejected: " + JSON.stringify(body));
  }

  // 5. verify stealth got SOL
  console.log("\n[5] verify stealth received SOL");
  const stealthBalance = await conn.getBalance(stealth.publicKey);
  console.log(`  stealth ${stealth.publicKey.toBase58()} balance: ${stealthBalance} lamports`);
  if (stealthBalance === 0) throw new Error("stealth got nothing");

  console.log("\n===============================");
  console.log("✓ production round-trip works");
  console.log(`  withdraw sig: ${body.withdrawSig}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
