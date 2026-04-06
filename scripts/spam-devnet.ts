/**
 * Generates devnet activity against the KIRITE program.
 * Sends N memo transactions tagging the program ID so the
 * program account shows recent usage on Solana Explorer.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync } from "fs";
import { homedir } from "os";

const PROGRAM_ID = new PublicKey("4bUHrDPuRcoYPU7UTLojXtxJsWoCj3HJbKX9oLnEnYy6");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

async function main() {
  const N = parseInt(process.argv[2] || "30", 10);
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf-8"))),
  );

  const labels = [
    "kirite:confidential_transfer",
    "kirite:shield_pool_deposit",
    "kirite:shield_pool_withdraw",
    "kirite:stealth_register",
    "kirite:stealth_claim",
  ];

  for (let i = 0; i < N; i++) {
    const label = labels[i % labels.length];
    const tx = new Transaction().add(
      new TransactionInstruction({
        keys: [
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: MEMO,
        data: Buffer.from(`${label} #${i}`, "utf-8"),
      }),
    );
    try {
      const sig = await sendAndConfirmTransaction(conn, tx, [wallet]);
      console.log(`${i + 1}/${N} ${label} ${sig}`);
    } catch (e: any) {
      console.log(`${i + 1}/${N} failed: ${e.message?.slice(0, 100)}`);
    }
  }
}

main().catch(console.error);
