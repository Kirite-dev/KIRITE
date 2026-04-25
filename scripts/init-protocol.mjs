/**
 * Initialize the KIRITE ProtocolConfig + GovernanceState PDAs on devnet.
 *
 * Runs once per program deploy. Sets fee_bps=10 (0.1%) and
 * burn_ratio_bps=5000 (50% of fees burned). Authority = operator wallet.
 * Treasury = operator wallet for devnet simplicity.
 *
 * Usage:
 *   node scripts/init-protocol.mjs
 */

import anchorPkg from "@coral-xyz/anchor";
const anchor = anchorPkg.default ?? anchorPkg;
const { BN, Program, AnchorProvider, Wallet } = anchor;
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import fs from "node:fs";
import os from "node:os";
import { PROGRAM_ID, deriveProtocolConfig } from "../sdk/src/kirite.mjs";

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
  const idl = JSON.parse(
    fs.readFileSync("./programs/kirite/idl/kirite.json", "utf-8")
  );
  const provider = new AnchorProvider(connection, new Wallet(wallet), {
    commitment: "confirmed",
  });
  const program = new Program(idl, provider);

  const [protocolConfig] = deriveProtocolConfig();
  const [governanceState] = PublicKey.findProgramAddressSync(
    [Buffer.from("governance"), protocolConfig.toBuffer()],
    PROGRAM_ID
  );

  console.log("authority:      ", wallet.publicKey.toBase58());
  console.log("protocolConfig: ", protocolConfig.toBase58());
  console.log("governanceState:", governanceState.toBase58());

  const existing = await connection.getAccountInfo(protocolConfig);
  if (existing) {
    console.log("protocol already initialized, skipping.");
    return;
  }

  // Treasury can be passed explicitly (process.argv[2]) so on mainnet
  // we point it at the relayer pubkey. That way fees collected on every
  // withdraw flow back into the relayer's SOL balance, paying for its
  // own gas. The relayer becomes self-funding once volume exceeds gas
  // costs (~10 withdraws/day at 0.01 SOL denom break even).
  const treasuryPub = process.argv[2]
    ? new PublicKey(process.argv[2])
    : wallet.publicKey;
  console.log("treasury:       ", treasuryPub.toBase58());

  const tx = await program.methods
    .initializeProtocol(10, 5000)
    .accounts({
      protocolConfig,
      governanceState,
      authority: wallet.publicKey,
      treasury: treasuryPub,
      systemProgram: SystemProgram.programId,
    })
    .signers([wallet])
    .rpc();

  console.log("\nOK protocol initialized");
  console.log("  tx:", tx);
}

main().catch((e) => {
  console.error("init failed:", e.message);
  if (e.logs) for (const l of e.logs) console.error("  ", l);
  process.exit(1);
});
