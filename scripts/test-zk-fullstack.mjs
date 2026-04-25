/**
 * Full-stack devnet test: browser-generated proof verified by the
 * on-chain Solana program.
 *
 * Spins up the deployed miniapp, generates a real Groth16 proof from
 * inside Chromium against a fresh devnet deposit, then submits the
 * withdraw via the same wallet acting as relayer. If the on-chain
 * verifier accepts a browser-produced proof, the entire stack is sound:
 *   miniapp → wasm/zkey → snarkjs proof → groth16-solana → recipient.
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
  KIRITE_PROGRAM_ID,
  deriveShieldPool,
  deriveVaultAuthority,
  buildDepositIx,
  buildWithdrawIx,
  decodeShieldPool,
  fetchPoolLeaves,
} from "../sdk/src/kirite-zk.mjs";
import { computeCommitment, randomFieldBytes } from "../sdk/src/zk.mjs";

const DENOM = 5_000_000n;
const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
const MINIAPP_URL = process.env.MINIAPP_URL || "https://kirite-tg.vercel.app";

function loadKp() {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf-8"))),
  );
}

async function generateProofInBrowser(page, opts) {
  return await page.evaluate(async (input) => {
    const KZK = window.KZK;
    await KZK.warmUp();
    const r = await KZK.generateMembershipProof({
      nullifierSecret: new Uint8Array(input.ns),
      blindingFactor: new Uint8Array(input.bf),
      amount: BigInt(input.amount),
      leafIndex: input.leafIndex,
      allLeaves: input.leaves.map((b) => b ? new Uint8Array(b) : null),
      recipientPubkey: new Uint8Array(input.recipient),
    });
    return {
      proof: Array.from(r.proof),
      publicInputs: {
        root: Array.from(r.publicInputs.root),
        nullifierHash: Array.from(r.publicInputs.nullifierHash),
        amount: Array.from(r.publicInputs.amount),
        recipientHash: Array.from(r.publicInputs.recipientHash),
      },
    };
  }, opts);
}

async function main() {
  console.log("KIRITE v3 full-stack browser→chain test");
  console.log("=======================================\n");

  const conn = new Connection(RPC, "confirmed");
  const payer = loadKp();
  console.log("payer:", payer.publicKey.toBase58());

  const [pool] = deriveShieldPool(NATIVE_MINT, DENOM);
  const [vaultAuthority] = deriveVaultAuthority(pool);
  const vault = await getAssociatedTokenAddress(NATIVE_MINT, vaultAuthority, true);
  const treasuryAta = await getAssociatedTokenAddress(NATIVE_MINT, payer.publicKey);

  // ── 1. deposit on chain ───────────────────────────────────────────
  console.log("[1] deposit fresh leaf");
  const ata = await getAssociatedTokenAddress(NATIVE_MINT, payer.publicKey);
  const wrapTx = new Transaction();
  wrapTx.add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, payer.publicKey, NATIVE_MINT),
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: ata,
      lamports: Number(DENOM),
    }),
    createSyncNativeInstruction(ata),
  );
  await conn.confirmTransaction(await conn.sendTransaction(wrapTx, [payer]), "confirmed");

  const poolInfo = await conn.getAccountInfo(pool);
  const decoded = decodeShieldPool(poolInfo.data);
  const leafIndex = decoded.nextLeafIndex;
  const ns = randomFieldBytes();
  const bf = randomFieldBytes();
  const commitment = await computeCommitment(ns, DENOM, bf, leafIndex);

  const depIx = buildDepositIx({
    depositor: payer.publicKey,
    depositorTokenAccount: ata,
    vault,
    shieldPool: pool,
    commitment,
  });
  const depSig = await conn.sendTransaction(new Transaction().add(depIx), [payer]);
  await conn.confirmTransaction(depSig, "confirmed");
  console.log(`  leaf=${leafIndex} sig=${depSig}`);

  // ── 2. recipient setup ────────────────────────────────────────────
  const recipient = Keypair.generate();
  const recipientAta = await getAssociatedTokenAddress(NATIVE_MINT, recipient.publicKey);
  await conn.confirmTransaction(
    await conn.sendTransaction(
      new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey, recipientAta, recipient.publicKey, NATIVE_MINT,
        ),
      ),
      [payer],
    ),
    "confirmed",
  );

  // ── 3. spin up Chromium, generate proof ───────────────────────────
  console.log("\n[2] launch headless browser → generate proof");
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(MINIAPP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Wait for KZK to register.
  await page.waitForFunction(() => !!window.KZK, { timeout: 30_000 });

  const allLeaves = await fetchPoolLeaves(conn, pool, { limit: 1000 });
  const leavesForBrowser = allLeaves.map((l) => (l ? Array.from(l) : null));

  const t0 = Date.now();
  const result = await generateProofInBrowser(page, {
    ns: Array.from(ns),
    bf: Array.from(bf),
    amount: DENOM.toString(),
    leafIndex,
    leaves: leavesForBrowser,
    recipient: Array.from(recipientAta.toBytes()),
  });
  const elapsed = Date.now() - t0;
  await browser.close();
  console.log(`  proof generated in browser in ${elapsed}ms`);

  const proof = new Uint8Array(result.proof);
  const publicInputs = {
    root: new Uint8Array(result.publicInputs.root),
    nullifierHash: new Uint8Array(result.publicInputs.nullifierHash),
    amount: new Uint8Array(result.publicInputs.amount),
    recipientHash: new Uint8Array(result.publicInputs.recipientHash),
  };

  // ── 4. submit on-chain withdraw using browser-generated proof ─────
  console.log("\n[3] submit withdraw with browser proof");
  const wIx = buildWithdrawIx({
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
  const wSig = await conn.sendTransaction(new Transaction().add(wIx), [payer]);
  await conn.confirmTransaction(wSig, "confirmed");
  console.log(`  withdraw sig: ${wSig}`);

  const acc = await getAccount(conn, recipientAta);
  if (acc.amount === 0n) throw new Error("recipient received nothing");
  console.log(`  recipient amount: ${acc.amount.toString()} lamports`);

  console.log("\n=======================================");
  console.log("✓ FULL-STACK PASSED — browser-produced Groth16 proof accepted on-chain");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
