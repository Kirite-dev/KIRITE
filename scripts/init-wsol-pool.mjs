/**
 * Initialize a shield pool for WSOL (wrapped SOL) at a given denomination.
 *
 * Prereq: `initialize_protocol` has already been called (ProtocolConfig PDA exists).
 * This script is idempotent — reruns are safe, it skips if the pool already exists.
 *
 * Usage:
 *   node scripts/init-wsol-pool.mjs [denomination_lamports] [timelock_seconds]
 * Defaults: 100000000 (0.1 SOL), 60 (1 min timelock)
 */

import anchorPkg from "@coral-xyz/anchor";
const anchor = anchorPkg.default ?? anchorPkg;
const { BN, Program, AnchorProvider, Wallet } = anchor;
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Connection,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAccount as createTokenAccount,
  NATIVE_MINT,
} from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";

const PROGRAM_ID = new PublicKey("4bUHrDPuRcoYPU7UTLojXtxJsWoCj3HJbKX9oLnEnYy6");
const WSOL_MINT = NATIVE_MINT; // So11111111111111111111111111111111111111112

const denomination = BigInt(process.argv[2] ?? 100_000_000n); // 0.1 SOL default
const timelockSeconds = BigInt(process.argv[3] ?? 60n);

function loadWallet() {
  const p = `${os.homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

async function main() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = loadWallet();
  const idlPath = "./programs/kirite/idl/kirite.json";
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const provider = new AnchorProvider(
    connection,
    new Wallet(wallet),
    { commitment: "confirmed" }
  );
  const program = new Program(idl, provider);

  console.log("wallet:", wallet.publicKey.toBase58());
  console.log(
    "balance:",
    ((await connection.getBalance(wallet.publicKey)) / 1e9).toFixed(4),
    "SOL"
  );

  // ─── PDAs ───────────────────────────────────────────────────────
  const [protocolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    PROGRAM_ID
  );
  console.log("protocolConfig:", protocolConfig.toBase58());

  const denomBytes = Buffer.alloc(8);
  denomBytes.writeBigUInt64LE(denomination);

  const [shieldPool] = PublicKey.findProgramAddressSync(
    [Buffer.from("shield_pool"), WSOL_MINT.toBuffer(), denomBytes],
    PROGRAM_ID
  );
  console.log("shieldPool:", shieldPool.toBase58());

  const existing = await connection.getAccountInfo(shieldPool);
  if (existing) {
    console.log("pool already exists, skipping init.");
    return;
  }

  const [nullifierSet] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier_set"), shieldPool.toBuffer()],
    PROGRAM_ID
  );
  console.log("nullifierSet:", nullifierSet.toBase58());

  // ─── Vault: WSOL token account owned by the shield pool PDA ─────
  const vaultKeypair = Keypair.generate();
  const vaultAccount = await createTokenAccount(
    connection,
    wallet,
    WSOL_MINT,
    shieldPool, // owner = pool PDA
    vaultKeypair
  );
  console.log("vault:", vaultAccount.toBase58());

  // ─── Call initialize_shield_pool ────────────────────────────────
  const tx = await program.methods
    .initializeShieldPool({
      denomination: new BN(denomination.toString()),
      timelockSeconds: new BN(timelockSeconds.toString()),
    })
    .accounts({
      shieldPool,
      nullifierSet,
      protocolConfig,
      vault: vaultAccount,
      mint: WSOL_MINT,
      operator: wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([wallet])
    .rpc();

  console.log("✓ shield pool initialized");
  console.log("  tx:", tx);
  console.log("  denom:", denomination.toString(), "lamports");
  console.log("  timelock:", timelockSeconds.toString(), "sec");
}

main().catch((e) => {
  console.error("init failed:", e.message);
  if (e.logs) {
    for (const l of e.logs) console.error("  ", l);
  }
  process.exit(1);
});
