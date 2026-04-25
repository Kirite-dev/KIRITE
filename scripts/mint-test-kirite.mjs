/**
 * Mint test KIRITE on devnet to a recipient address.
 * Usage: node scripts/mint-test-kirite.mjs <recipient_pubkey> [amount]
 */
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";

const RPC =
  "https://devnet.helius-rpc.com/?api-key=8fc70926-95dc-4e72-8557-7245bd7e36fa";
const MINT = new PublicKey("BRAEtwS6R3RmJVxvEthk5JfCXZdkbYAs6Vy2DrWr4aND");
const DECIMALS = 9;

async function main() {
  const recipient = process.argv[2];
  const amount = Number(process.argv[3] || 1000);
  if (!recipient) {
    console.error("usage: node scripts/mint-test-kirite.mjs <pubkey> [amount]");
    process.exit(1);
  }

  const conn = new Connection(RPC, "confirmed");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf-8")),
    ),
  );
  const recipientPk = new PublicKey(recipient);

  console.log("payer:    ", payer.publicKey.toBase58());
  console.log("recipient:", recipientPk.toBase58());
  console.log("mint:     ", MINT.toBase58());

  const bal = await conn.getBalance(payer.publicKey);
  console.log("payer SOL:", (bal / LAMPORTS_PER_SOL).toFixed(4));

  const ata = await getOrCreateAssociatedTokenAccount(conn, payer, MINT, recipientPk);
  console.log("ata:      ", ata.address.toBase58());

  const raw = BigInt(amount) * 10n ** BigInt(DECIMALS);
  const sig = await mintTo(conn, payer, MINT, ata.address, payer, raw);
  console.log(`minted ${amount} KIRITE`);
  console.log("tx:       ", sig);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
