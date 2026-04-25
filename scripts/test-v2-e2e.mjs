/**
 * End-to-end simulation of the TG mini-app v2 flow:
 *   1. Deposit WSOL into the Anchor shield pool at a given denom.
 *   2. Wait for the pool's timelock to expire.
 *   3. POST the note to the live relayer at /api/withdraw-v2.
 *   4. Verify the stealth recipient received the expected SOL.
 *
 * Usage:
 *   node scripts/test-v2-e2e.mjs [denom_lamports]  (default 100000000)
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
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KiriteClient,
  PROGRAM_ID,
  deriveShieldPool,
  deriveProtocolConfig,
  derivePoolEntry,
  computeCommitment,
  randomBytes32,
} from "../sdk/src/kirite.mjs";

const RELAYER_URL = "https://kirite-relayer.vercel.app";

const denomLamports = BigInt(process.argv[2] ?? 100_000_000n);

function hex(u) { return Buffer.from(u).toString("hex"); }

function loadWallet() {
  const p = `${os.homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8")))
  );
}

async function main() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = loadWallet();
  console.log("wallet:", wallet.publicKey.toBase58());
  console.log("balance:", ((await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL).toFixed(4), "SOL");
  console.log("denom:", denomLamports.toString(), "lamports");

  // Fresh "stealth" recipient — a new random keypair so we can verify
  // the landing balance. In the real flow the recipient would recover
  // this from their viewing key + the tx memo.
  const stealth = Keypair.generate();
  console.log("stealth (test):", stealth.publicKey.toBase58());

  // ─── Client-side: build v2 deposit ────────────────────────────────
  const [shieldPool] = deriveShieldPool(NATIVE_MINT, denomLamports);
  const client = await KiriteClient.load({
    connection,
    wallet,
    idlPath: "./programs/kirite/idl/kirite.json",
  });

  const poolState = await client.fetchPool(shieldPool);
  const leafIndex = poolState.nextLeafIndex;
  console.log("pool:", shieldPool.toBase58(), "next_leaf:", leafIndex, "timelock:", poolState.timelockSeconds.toString(), "s");

  const nullifierSecret = randomBytes32();
  const blindingFactor = randomBytes32();
  const commitment = computeCommitment(nullifierSecret, denomLamports, blindingFactor, leafIndex);
  const [poolEntry] = derivePoolEntry(shieldPool, commitment);
  console.log("commitment:", hex(commitment));

  // Ensure the depositor's WSOL ATA has `denom` balance.
  const depositorAta = await getAssociatedTokenAddress(NATIVE_MINT, wallet.publicKey);
  const prepIxs = [
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey, depositorAta, wallet.publicKey, NATIVE_MINT
    ),
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: depositorAta,
      lamports: Number(denomLamports),
    }),
    createSyncNativeInstruction(depositorAta),
  ];

  const depositIx = await client.program.methods
    .deposit({
      nullifierSecret: Array.from(nullifierSecret),
      blindingFactor: Array.from(blindingFactor),
      commitment: Array.from(commitment),
    })
    .accounts({
      shieldPool,
      protocolConfig: (await import("../sdk/src/kirite.mjs")).deriveProtocolConfig()[0],
      poolEntry,
      depositorTokenAccount: depositorAta,
      vault: poolState.vault,
      depositor: wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const tx = new Transaction().add(...prepIxs, depositIx);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  tx.sign(wallet);

  console.log("\nsubmitting deposit tx...");
  const depositSig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(depositSig, "confirmed");
  console.log("deposit sig:", depositSig);

  // Persist the note so a failed /api/withdraw-v2 can be retried
  // without making another deposit.
  const notePath = `./notes/v2-e2e-${Date.now()}.json`;
  fs.mkdirSync("./notes", { recursive: true });
  fs.writeFileSync(notePath, JSON.stringify({
    depositSig,
    nullifierSecretHex: hex(nullifierSecret),
    blindingFactorHex: hex(blindingFactor),
    commitmentHex: hex(commitment),
    leafIndex,
    stealthPubkey: stealth.publicKey.toBase58(),
    stealthSecret: Array.from(stealth.secretKey),
    denomLamports: denomLamports.toString(),
    mint: NATIVE_MINT.toBase58(),
  }, null, 2));
  console.log("note saved:", notePath);

  // ─── Wait for timelock to expire ─────────────────────────────────
  const waitSec = Number(poolState.timelockSeconds) + 10;
  console.log(`\nwaiting ${waitSec}s for timelock...`);
  const start = Date.now();
  while ((Date.now() - start) / 1000 < waitSec) {
    const remaining = waitSec - Math.floor((Date.now() - start) / 1000);
    process.stdout.write(`\r  ${remaining}s remaining   `);
    await new Promise((r) => setTimeout(r, 5_000));
  }
  process.stdout.write("\n");

  // ─── Relayer-assisted withdraw ───────────────────────────────────
  console.log("\nposting to /api/withdraw-v2...");
  const stealthBalPre = await connection.getBalance(stealth.publicKey);
  const body = {
    depositSig,
    nullifierSecretHex: hex(nullifierSecret),
    blindingFactorHex: hex(blindingFactor),
    commitmentHex: hex(commitment),
    leafIndex,
    stealthPubkey: stealth.publicKey.toBase58(),
    denomLamports: denomLamports.toString(),
    mint: NATIVE_MINT.toBase58(),
  };
  const res = await fetch(RELAYER_URL + "/api/withdraw-v2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const resp = await res.json();
  console.log("relayer response:", JSON.stringify(resp, null, 2));
  if (!res.ok) throw new Error("withdraw-v2 failed");

  // ─── Verify landing ──────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, 3_000));
  const stealthBalPost = await connection.getBalance(stealth.publicKey);
  const landed = (stealthBalPost - stealthBalPre) / LAMPORTS_PER_SOL;
  console.log("\nstealth pre :", stealthBalPre);
  console.log("stealth post:", stealthBalPost);
  console.log(`landed: ${landed} SOL`);

  // Pool state
  const newState = await client.fetchPool(shieldPool);
  console.log("\npool.total_withdrawals:", newState.totalWithdrawals.toString());
  const entry = await client.program.account.poolEntry.fetch(poolEntry);
  console.log("pool_entry.is_withdrawn:", entry.isWithdrawn);

  console.log("\nOK v2 E2E flow complete");
}

main().catch((e) => {
  console.error("\nFAILED:", e.message);
  if (e.logs) for (const l of e.logs) console.error("  ", l);
  process.exit(1);
});
