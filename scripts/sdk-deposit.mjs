/**
 * Deposit a fixed denomination into a KIRITE shield pool via the SDK.
 *
 * Usage:
 *   node scripts/sdk-deposit.mjs [denomination_lamports]
 * Default denomination: 100000000 (0.1 SOL)
 *
 * Writes the resulting note to ./notes/<timestamp>.note.json (keep it safe —
 * losing the note means losing the deposit).
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { NATIVE_MINT, getAccount } from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KiriteClient,
  deriveShieldPool,
  ensureAta,
  buildWrapSolIxs,
  encodeNote,
} from "../sdk/src/kirite.mjs";

const denomination = BigInt(process.argv[2] ?? 100_000_000n); // 0.1 SOL default

function loadWallet() {
  const p = `${os.homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8")))
  );
}

async function main() {
  const connection = new Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );
  const wallet = loadWallet();
  console.log("wallet:", wallet.publicKey.toBase58());
  const bal = await connection.getBalance(wallet.publicKey);
  console.log("balance:", (bal / 1e9).toFixed(4), "SOL");

  const client = await KiriteClient.load({
    connection,
    wallet,
    idlPath: "./programs/kirite/idl/kirite.json",
  });

  const [shieldPool] = deriveShieldPool(NATIVE_MINT, denomination);
  console.log("pool:", shieldPool.toBase58());

  const poolInfo = await connection.getAccountInfo(shieldPool);
  if (!poolInfo) {
    throw new Error(
      `pool not initialized for denom=${denomination}. Run init-wsol-pool first.`
    );
  }
  const poolState = await client.fetchPool(shieldPool);
  console.log("pool vault:", poolState.vault.toBase58());
  console.log("pool next_leaf_index:", poolState.nextLeafIndex);
  console.log("pool timelock:", poolState.timelockSeconds.toString(), "sec");

  // Ensure depositor WSOL ATA exists and holds at least `denomination`.
  // Only wrap additional SOL if the existing balance is short.
  const { ata: depositorAta, createIx } = await ensureAta({
    connection,
    payer: wallet.publicKey,
    mint: NATIVE_MINT,
    owner: wallet.publicKey,
  });
  console.log("depositor WSOL ATA:", depositorAta.toBase58());

  let wsolBalance = 0n;
  try {
    const acc = await getAccount(connection, depositorAta);
    wsolBalance = BigInt(acc.amount.toString());
  } catch {
    wsolBalance = 0n;
  }
  console.log("existing WSOL balance:", (Number(wsolBalance) / 1e9).toFixed(4));

  if (wsolBalance < denomination) {
    const shortfall = denomination - wsolBalance;
    // Need: shortfall + ~0.0016 SOL for PoolEntry PDA rent + tx fees.
    const overhead = 1_600_000n;
    if (BigInt(bal) < shortfall + overhead) {
      throw new Error(
        `insufficient SOL to top up WSOL: need ${shortfall + overhead}, have ${bal}`
      );
    }
    const prepIxs = [];
    if (createIx) prepIxs.push(createIx);
    prepIxs.push(
      ...buildWrapSolIxs({
        owner: wallet.publicKey,
        ata: depositorAta,
        lamports: shortfall,
      })
    );
    const prepTx = new Transaction().add(...prepIxs);
    const prepSig = await connection.sendTransaction(prepTx, [wallet], {
      skipPreflight: false,
    });
    await connection.confirmTransaction(prepSig, "confirmed");
    console.log("topped up WSOL by", shortfall.toString(), "sig:", prepSig);
  } else {
    console.log("WSOL balance sufficient, skipping wrap.");
  }

  const result = await client.deposit({
    mint: NATIVE_MINT,
    denominationLamports: denomination,
    depositorTokenAccount: depositorAta,
    signer: wallet,
  });

  console.log("\nOK deposit committed");
  console.log("  sig:", result.signature);
  console.log("  leaf_index:", result.note.leafIndex);
  console.log("  commitment:", result.note.commitment);

  // Persist the note.
  const notesDir = path.resolve("./notes");
  fs.mkdirSync(notesDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const notePath = path.join(notesDir, `${ts}.note.json`);
  fs.writeFileSync(notePath, JSON.stringify(result.note, null, 2));
  const encoded = encodeNote(result.note);
  fs.writeFileSync(notePath.replace(".json", ".b64"), encoded);

  console.log("\nnote saved:");
  console.log("  json:", notePath);
  console.log("  encoded:", encoded.slice(0, 60) + "...");
  console.log("\nKEEP THIS NOTE — it is the only way to withdraw.");
}

main().catch((e) => {
  console.error("deposit failed:", e.message);
  if (e.logs) for (const l of e.logs) console.error("  ", l);
  process.exit(1);
});
