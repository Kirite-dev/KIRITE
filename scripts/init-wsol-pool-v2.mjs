/**
 * Initialize a shield pool for WSOL with the CORRECT vault authority.
 *
 * The original init-wsol-pool.mjs made the vault's token-account owner
 * the shield_pool PDA itself, which breaks withdraw (the program's
 * CPI signs as `vault_authority` PDA, not `shield_pool`). This script
 * creates the vault with owner = vault_authority PDA.
 *
 * Usage:
 *   node scripts/init-wsol-pool-v2.mjs [denomination_lamports] [timelock_seconds]
 * Defaults: 20000000 (0.02 SOL), 600 (10 min, program minimum)
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
import {
  PROGRAM_ID,
  deriveProtocolConfig,
  deriveShieldPool,
  deriveNullifierSet,
  deriveVaultAuthority,
} from "../sdk/src/kirite.mjs";

const denomination = BigInt(process.argv[2] ?? 20_000_000n);
const timelockSeconds = BigInt(process.argv[3] ?? 600n);

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

  console.log("wallet:", wallet.publicKey.toBase58());
  const bal = await connection.getBalance(wallet.publicKey);
  console.log("balance:", (bal / 1e9).toFixed(4), "SOL");

  const [protocolConfig] = deriveProtocolConfig();
  const [shieldPool] = deriveShieldPool(NATIVE_MINT, denomination);
  const [nullifierSet] = deriveNullifierSet(shieldPool);
  const [vaultAuthority] = deriveVaultAuthority(shieldPool);

  console.log("protocolConfig:", protocolConfig.toBase58());
  console.log("shieldPool:    ", shieldPool.toBase58());
  console.log("nullifierSet:  ", nullifierSet.toBase58());
  console.log("vaultAuthority:", vaultAuthority.toBase58());

  if (await connection.getAccountInfo(shieldPool)) {
    console.log("pool already exists for this denom; exiting.");
    return;
  }

  const vaultKeypair = Keypair.generate();
  const vault = await createTokenAccount(
    connection,
    wallet,
    NATIVE_MINT,
    vaultAuthority, // owner = vault_authority PDA (correct)
    vaultKeypair
  );
  console.log("vault:", vault.toBase58());

  const tx = await program.methods
    .initializeShieldPool({
      denomination: new BN(denomination.toString()),
      timelockSeconds: new BN(timelockSeconds.toString()),
    })
    .accounts({
      shieldPool,
      nullifierSet,
      protocolConfig,
      vault,
      mint: NATIVE_MINT,
      operator: wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([wallet])
    .rpc();

  console.log("\nOK shield pool initialized");
  console.log("  tx:      ", tx);
  console.log("  denom:   ", denomination.toString(), "lamports");
  console.log("  timelock:", timelockSeconds.toString(), "sec");
  console.log("  pool:    ", shieldPool.toBase58());
}

main().catch((e) => {
  console.error("init failed:", e.message);
  if (e.logs) for (const l of e.logs) console.error("  ", l);
  process.exit(1);
});
