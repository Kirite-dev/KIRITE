/**
 * Add WSOL (NATIVE_MINT) to the protocol's supported_mints allowlist.
 * Required because the new binary enforces require_supported_mint on
 * deposit / withdraw / pool init.
 *
 * Usage:
 *   node scripts/add-supported-mint.mjs                    # WSOL on devnet
 *   MINT=<base58> node scripts/add-supported-mint.mjs      # any mint
 *   RPC_URL=... node scripts/add-supported-mint.mjs        # any cluster
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";

import {
  KIRITE_PROGRAM_ID,
  deriveProtocolConfig,
} from "../sdk/src/kirite-zk.mjs";

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const MINT = process.env.MINT
  ? new PublicKey(process.env.MINT)
  : NATIVE_MINT;

function disc(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function loadKp() {
  const path = process.env.KEYPAIR ||
    `${os.homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))),
  );
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const authority = loadKp();
  console.log(`authority: ${authority.publicKey.toBase58()}`);
  console.log(`mint:      ${MINT.toBase58()}`);
  console.log(`program:   ${KIRITE_PROGRAM_ID.toBase58()}`);

  const [protocolConfig] = deriveProtocolConfig();
  console.log(`config:    ${protocolConfig.toBase58()}`);

  const ix = new TransactionInstruction({
    programId: KIRITE_PROGRAM_ID,
    keys: [
      { pubkey: protocolConfig, isSigner: false, isWritable: true },
      { pubkey: MINT, isSigner: false, isWritable: false },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(disc("add_supported_mint")),
  });

  const sig = await conn.sendTransaction(new Transaction().add(ix), [authority]);
  await conn.confirmTransaction(sig, "confirmed");
  console.log(`\n✓ added supported mint: ${sig}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
