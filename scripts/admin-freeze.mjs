/**
 * Operator-only emergency switch. Freezes (or unfreezes) a shield pool
 * by `denom` so the on-chain program rejects further deposits and
 * withdraws against it. Use this if a bug is discovered after launch
 * before pushing a real program upgrade.
 *
 * Auth: signs with the wallet at ~/.config/solana/id.json, which must
 * be the protocol authority (the deployer of the program).
 *
 * Usage:
 *   node scripts/admin-freeze.mjs freeze   <denom_lamports> [reason]
 *   node scripts/admin-freeze.mjs unfreeze <denom_lamports>
 *
 * Examples:
 *   node scripts/admin-freeze.mjs freeze 100000000 "investigating bug"
 *   node scripts/admin-freeze.mjs unfreeze 100000000
 */

import anchorPkg from "@coral-xyz/anchor";
const anchor = anchorPkg.default ?? anchorPkg;
const { Program, AnchorProvider, Wallet } = anchor;
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import { deriveShieldPool, deriveProtocolConfig } from "../sdk/src/kirite.mjs";

const action = process.argv[2];
const denomArg = process.argv[3];
const reason = process.argv[4] || "operator emergency freeze";

if (action !== "freeze" && action !== "unfreeze") {
  console.error("usage: node scripts/admin-freeze.mjs <freeze|unfreeze> <denom_lamports> [reason]");
  process.exit(1);
}
if (!denomArg) {
  console.error("denom required");
  process.exit(1);
}
const denom = BigInt(denomArg);

const wallet = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf-8")))
);

async function main() {
  const rpc = process.env.RPC_URL || "https://api.devnet.solana.com";
  const connection = new Connection(rpc, "confirmed");
  const idl = JSON.parse(fs.readFileSync("./programs/kirite/idl/kirite.json", "utf-8"));
  const provider = new AnchorProvider(connection, new Wallet(wallet), { commitment: "confirmed" });
  const program = new Program(idl, provider);

  const [shieldPool] = deriveShieldPool(NATIVE_MINT, denom);
  const [protocolConfig] = deriveProtocolConfig();
  console.log("authority:     ", wallet.publicKey.toBase58());
  console.log("shieldPool:    ", shieldPool.toBase58());
  console.log("denom:         ", denom.toString());
  console.log("action:        ", action);

  let sig;
  if (action === "freeze") {
    console.log("reason:        ", reason);
    sig = await program.methods
      .freezePool(reason)
      .accounts({ shieldPool, protocolConfig, authority: wallet.publicKey })
      .signers([wallet])
      .rpc();
  } else {
    sig = await program.methods
      .unfreezePool()
      .accounts({ shieldPool, protocolConfig, authority: wallet.publicKey })
      .signers([wallet])
      .rpc();
  }
  console.log("\nOK", action, "sig:", sig);
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  if (e.logs) for (const l of e.logs) console.error("  ", l);
  process.exit(1);
});
