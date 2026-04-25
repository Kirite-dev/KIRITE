/**
 * Withdraw from a KIRITE shield pool using a previously-saved note.
 *
 * Usage:
 *   node scripts/sdk-withdraw.mjs <note.json-or-.b64> [recipient_pubkey]
 *
 * The note path must be either the JSON or the base64url form written by
 * sdk-deposit.mjs. If `recipient_pubkey` is omitted, the withdraw goes to
 * the wallet's own WSOL ATA (useful for smoke tests; in production the
 * recipient should be a fresh stealth address).
 *
 * A fresh relayer keypair is generated per call to provide
 * sender/recipient unlinkability at the rent-payer level.
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
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KiriteClient,
  decodeNote,
  deriveShieldPool,
  deriveVaultAuthority,
} from "../sdk/src/kirite.mjs";

function loadWallet() {
  const p = `${os.homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8")))
  );
}

function loadNote(file) {
  const raw = fs.readFileSync(file, "utf-8").trim();
  if (file.endsWith(".json") || raw.startsWith("{")) return JSON.parse(raw);
  return decodeNote(raw);
}

async function main() {
  const notePath = process.argv[2];
  if (!notePath) {
    console.error(
      "usage: node scripts/sdk-withdraw.mjs <note.json-or-.b64> [recipient_pubkey]"
    );
    process.exit(1);
  }
  const note = loadNote(notePath);
  console.log("loaded note:");
  console.log("  pool:        ", note.pool);
  console.log("  denom:       ", note.denomination);
  console.log("  leaf_index:  ", note.leafIndex);
  console.log("  commitment:  ", note.commitment);
  console.log("  deposited_at:", note.depositedAt);

  const connection = new Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );
  const wallet = loadWallet();

  // Fund a fresh relayer keypair with just enough SOL to pay gas + rent.
  const relayer = Keypair.generate();
  const relayerSeed = 20_000_000; // 0.02 SOL
  console.log("\nfunding fresh relayer:", relayer.publicKey.toBase58());
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: relayer.publicKey,
      lamports: relayerSeed,
    })
  );
  const fundSig = await connection.sendTransaction(fundTx, [wallet]);
  await connection.confirmTransaction(fundSig, "confirmed");
  console.log("  funded with", relayerSeed / LAMPORTS_PER_SOL, "SOL");

  // Resolve recipient and treasury token accounts.
  const recipient = process.argv[3]
    ? new PublicKey(process.argv[3])
    : wallet.publicKey;
  const recipientAta = await getAssociatedTokenAddress(NATIVE_MINT, recipient);
  const treasuryAta = await getAssociatedTokenAddress(
    NATIVE_MINT,
    wallet.publicKey // operator doubles as treasury on devnet
  );

  // Create recipient ATA if missing (relayer pays). Treasury ATA should
  // already exist from the depositor's wrap.
  const prepIxs = [];
  if (!(await connection.getAccountInfo(recipientAta))) {
    prepIxs.push(
      createAssociatedTokenAccountInstruction(
        relayer.publicKey,
        recipientAta,
        recipient,
        NATIVE_MINT
      )
    );
  }
  if (!(await connection.getAccountInfo(treasuryAta))) {
    prepIxs.push(
      createAssociatedTokenAccountInstruction(
        relayer.publicKey,
        treasuryAta,
        wallet.publicKey,
        NATIVE_MINT
      )
    );
  }
  if (prepIxs.length) {
    const tx = new Transaction().add(...prepIxs);
    const sig = await connection.sendTransaction(tx, [relayer]);
    await connection.confirmTransaction(sig, "confirmed");
    console.log("  prep tx:", sig);
  }

  console.log("\nrecipient ATA:", recipientAta.toBase58());
  console.log("treasury ATA:", treasuryAta.toBase58());

  const client = await KiriteClient.load({
    connection,
    wallet: relayer, // relayer is the tx payer / provider signer
    idlPath: "./programs/kirite/idl/kirite.json",
  });

  const { signature } = await client.withdraw({
    note,
    recipientTokenAccount: recipientAta,
    treasuryTokenAccount: treasuryAta,
    relayerSigner: relayer,
  });

  console.log("\nOK withdraw executed");
  console.log("  sig:", signature);
}

main().catch((e) => {
  console.error("withdraw failed:", e.message);
  if (e.logs) for (const l of e.logs) console.error("  ", l);
  process.exit(1);
});
