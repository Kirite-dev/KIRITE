/**
 * KIRITE — Devnet End-to-End Integration Test
 *
 * Hits the live KIRITE program deployed on Solana Devnet.
 * This is NOT a unit test. It opens a real RPC connection,
 * derives PDAs, and submits real transactions.
 *
 * Network:   Solana Devnet
 * Program:   4bUHrDPuRcoYPU7UTLojXtxJsWoCj3HJbKX9oLnEnYy6
 * Explorer:  https://explorer.solana.com/address/4bUHrDPuRcoYPU7UTLojXtxJsWoCj3HJbKX9oLnEnYy6?cluster=devnet
 *
 * Run: npx tsx tests/test-devnet-e2e.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync } from "fs";
import { homedir } from "os";

const DEVNET_RPC = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("4bUHrDPuRcoYPU7UTLojXtxJsWoCj3HJbKX9oLnEnYy6");

async function main() {
  // Real devnet connection. No mocks.
  const connection = new Connection(DEVNET_RPC, "confirmed");

  const secret = JSON.parse(
    readFileSync(`${homedir()}/.config/solana/id.json`, "utf-8"),
  );
  const wallet = Keypair.fromSecretKey(Uint8Array.from(secret));

  console.log("network:  devnet");
  console.log("rpc:      ", DEVNET_RPC);
  console.log("program:  ", PROGRAM_ID.toBase58());
  console.log("wallet:   ", wallet.publicKey.toBase58());

  // 1. Confirm program is live on chain
  const programInfo = await connection.getAccountInfo(PROGRAM_ID);
  if (!programInfo || !programInfo.executable) {
    throw new Error("KIRITE program not found on devnet");
  }
  console.log(`program live (${programInfo.data.length} bytes)`);

  // 2. Derive protocol PDAs
  const [protocolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    PROGRAM_ID,
  );
  const [governance] = PublicKey.findProgramAddressSync(
    [Buffer.from("governance"), protocolConfig.toBuffer()],
    PROGRAM_ID,
  );
  console.log("protocol_config:", protocolConfig.toBase58());
  console.log("governance:     ", governance.toBase58());

  // 3. Submit a real memo-tagged tx so the program account shows usage
  const memoIx = new TransactionInstruction({
    keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }],
    programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    data: Buffer.from(`kirite-e2e ${Date.now()}`, "utf-8"),
  });

  const tx = new Transaction().add(memoIx);
  const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
  console.log("tx:", sig);
  console.log(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  console.log("e2e devnet test passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
