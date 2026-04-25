/**
 * Stress test: fire N concurrent deposits to a single pool with the
 * same retry logic the mini-app uses, and report success/race rates.
 *
 *   node scripts/stress-deposit.mjs <denom_lamports> <count>
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
  NATIVE_MINT,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import {
  KiriteClient,
  deriveShieldPool,
  deriveProtocolConfig,
  derivePoolEntry,
  computeCommitment,
  randomBytes32,
} from "../sdk/src/kirite.mjs";

const denom = BigInt(process.argv[2] ?? 10_000_000n);
const count = Number(process.argv[3] ?? 10);

const wallet = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf-8")))
);

async function withRetry(connection, client, ata, label) {
  const [shieldPool] = deriveShieldPool(NATIVE_MINT, denom);
  const [protocolConfig] = deriveProtocolConfig();
  let attempt = 0;
  let lastErr = null;
  while (attempt < 4) {
    attempt++;
    try {
      const state = await client.fetchPool(shieldPool);
      if (state.nextLeafIndex >= 32) throw new Error("POOL_FULL");
      const ns = randomBytes32();
      const bf = randomBytes32();
      const c = computeCommitment(ns, denom, bf, state.nextLeafIndex);
      const [poolEntry] = derivePoolEntry(shieldPool, c);
      const ix = await client.program.methods
        .deposit({
          nullifierSecret: Array.from(ns),
          blindingFactor: Array.from(bf),
          commitment: Array.from(c),
        })
        .accounts({
          shieldPool,
          protocolConfig,
          poolEntry,
          depositorTokenAccount: ata,
          vault: state.vault,
          depositor: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, ata, wallet.publicKey, NATIVE_MINT),
        SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: ata, lamports: Number(denom) }),
        createSyncNativeInstruction(ata),
        ix
      );
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;
      tx.sign(wallet);
      const sig = await connection.sendRawTransaction(tx.serialize());
      const status = await connection.confirmTransaction(sig, "confirmed");
      if (status.value.err) {
        const code = status.value.err?.InstructionError?.[1]?.Custom;
        if (code === 6017) {
          lastErr = new Error("race (Custom:6017)");
          await new Promise((r) => setTimeout(r, 800 + Math.random() * 800));
          continue;
        }
        throw new Error("reverted: " + JSON.stringify(status.value.err));
      }
      return { label, ok: true, sig, attempt };
    } catch (e) {
      lastErr = e;
      const msg = e?.message || String(e);
      if (msg === "POOL_FULL") return { label, ok: false, reason: "pool_full", attempt };
      const isRace = msg.includes("0x1781") || msg.includes("Custom:6017") || msg.includes("InvalidAmountProof") || msg.startsWith("race");
      if (!isRace) return { label, ok: false, reason: msg.slice(0, 120), attempt };
      await new Promise((r) => setTimeout(r, 800 + Math.random() * 800));
    }
  }
  return { label, ok: false, reason: lastErr?.message?.slice(0, 120) || "unknown", attempt };
}

async function main() {
  const connection = new Connection(
    process.env.RPC_URL || "https://devnet.helius-rpc.com/?api-key=8fc70926-95dc-4e72-8557-7245bd7e36fa",
    "confirmed"
  );
  const client = await KiriteClient.load({
    connection,
    wallet,
    idlPath: "./programs/kirite/idl/kirite.json",
  });
  const ata = await getAssociatedTokenAddress(NATIVE_MINT, wallet.publicKey);

  console.log(`firing ${count} concurrent deposits at denom=${denom} lamports`);
  const start = Date.now();
  const results = await Promise.all(
    Array.from({ length: count }, (_, i) => withRetry(connection, client, ata, "d" + i))
  );
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  let ok = 0, fail = 0;
  const reasons = {};
  let totalAttempts = 0;
  for (const r of results) {
    totalAttempts += r.attempt;
    if (r.ok) ok++;
    else { fail++; reasons[r.reason] = (reasons[r.reason] || 0) + 1; }
  }

  console.log(`\nelapsed: ${elapsed}s`);
  console.log(`success: ${ok}/${count}`);
  console.log(`failure: ${fail}/${count}`);
  console.log(`avg attempts/tx: ${(totalAttempts / count).toFixed(2)}`);
  if (fail > 0) {
    console.log("failure reasons:");
    for (const [r, n] of Object.entries(reasons)) console.log(`  ${n}× ${r}`);
  }

  // Pool end state
  const [shieldPool] = deriveShieldPool(NATIVE_MINT, denom);
  const finalState = await client.fetchPool(shieldPool);
  console.log(`\npool end state: leaf_index=${finalState.nextLeafIndex} (cap=32) deposits=${finalState.totalDeposits.toString()}`);
}

main().catch((e) => {
  console.error("STRESS FAILED:", e.message);
  process.exit(1);
});
