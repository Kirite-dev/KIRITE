/**
 * Toggle drain_mode on the mainnet KIRITE staking pool.
 * Usage:
 *   node scripts/admin-toggle-drain.mjs on   # enable drain (unstake bypasses lock)
 *   node scripts/admin-toggle-drain.mjs off  # disable drain (locks enforced again)
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  STAKING_PROGRAM_ID,
  deriveStakingPool,
  decodeStakingPool,
} from "../sdk/src/staking.mjs";

const RPC =
  "https://mainnet.helius-rpc.com/?api-key=8fc70926-95dc-4e72-8557-7245bd7e36fa";
const AUTHORITY_KEYPAIR =
  process.env.AUTHORITY_KEYPAIR ||
  "/mnt/c/Users/baayo/.config/solana/kirite-mainnet-deploy.json";

const arg = (process.argv[2] || "").toLowerCase();
if (arg !== "on" && arg !== "off") {
  console.error("usage: node scripts/admin-toggle-drain.mjs <on|off>");
  process.exit(1);
}
const enable = arg === "on";

function disc(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function loadKp(p) {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))),
  );
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const authority = loadKp(AUTHORITY_KEYPAIR);
  const [pool] = deriveStakingPool();

  console.log("authority:", authority.publicKey.toBase58());
  console.log("pool:    ", pool.toBase58());
  console.log("toggle:  ", enable ? "ENABLE drain" : "DISABLE drain");

  const data = Buffer.concat([
    disc("set_drain_mode"),
    Buffer.from([enable ? 1 : 0]),
  ]);

  const ix = new TransactionInstruction({
    programId: STAKING_PROGRAM_ID,
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  const sig = await conn.sendTransaction(tx, [authority]);
  await conn.confirmTransaction(sig, "confirmed");
  console.log("tx:      ", sig);

  const acc = await conn.getAccountInfo(pool);
  const decoded = decodeStakingPool(acc.data);
  console.log("\npool state:");
  console.log("  is_draining:     ", decoded.isDraining);
  console.log("  drain_started_at:", decoded.drainStartedAt.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
