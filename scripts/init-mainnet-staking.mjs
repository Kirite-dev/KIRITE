/**
 * Initialize the KIRITE staking pool on MAINNET.
 * Uses the real KIRITE mint (7iRJcjWHQMvdMXufPxLWBqfmBvikzETYTyjqnyCjpump).
 * Authority = mainnet-deploy.json wallet.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import {
  STAKING_PROGRAM_ID,
  deriveStakingPool,
  deriveVaultAuthority,
  deriveFeeVault,
  buildInitializeIx,
  decodeStakingPool,
} from "../sdk/src/staking.mjs";

const RPC =
  "https://mainnet.helius-rpc.com/?api-key=8fc70926-95dc-4e72-8557-7245bd7e36fa";
const KIRITE_MINT = new PublicKey(
  "7iRJcjWHQMvdMXufPxLWBqfmBvikzETYTyjqnyCjpump",
);
const AUTHORITY_KEYPAIR =
  process.env.AUTHORITY_KEYPAIR ||
  "/mnt/c/Users/baayo/.config/solana/kirite-mainnet-deploy.json";

function loadKp(p) {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))),
  );
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const authority = loadKp(AUTHORITY_KEYPAIR);
  console.log("authority:        ", authority.publicKey.toBase58());
  console.log("staking program: ", STAKING_PROGRAM_ID.toBase58());
  console.log("kirite mint:     ", KIRITE_MINT.toBase58());

  const bal = await conn.getBalance(authority.publicKey);
  console.log("authority SOL:   ", (bal / LAMPORTS_PER_SOL).toFixed(4));

  const [pool] = deriveStakingPool();
  const [vaultAuthority] = deriveVaultAuthority(pool);
  const [feeVault] = deriveFeeVault(pool);
  console.log("pool PDA:        ", pool.toBase58());
  console.log("vaultAuthority:  ", vaultAuthority.toBase58());
  console.log("feeVault:        ", feeVault.toBase58());

  const kiriteVault = await getAssociatedTokenAddress(
    KIRITE_MINT,
    vaultAuthority,
    true,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  console.log("kirite_vault:    ", kiriteVault.toBase58());

  // 1. Create kirite_vault ATA owned by vault_authority (Token-2022)
  const vaultAcc = await conn.getAccountInfo(kiriteVault);
  if (!vaultAcc) {
    console.log("creating kirite_vault ATA (Token-2022)...");
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        authority.publicKey,
        kiriteVault,
        vaultAuthority,
        KIRITE_MINT,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    const sig = await conn.sendTransaction(tx, [authority]);
    await conn.confirmTransaction(sig, "confirmed");
    console.log("ATA created:    ", sig);
  } else {
    console.log("kirite_vault ATA already exists");
  }

  // 2. Initialize the pool
  const poolAcc = await conn.getAccountInfo(pool);
  if (!poolAcc) {
    console.log("initializing pool...");
    const ix = buildInitializeIx({
      authority: authority.publicKey,
      kiriteMint: KIRITE_MINT,
      kiriteVault,
    });
    const tx = new Transaction().add(ix);
    const sig = await conn.sendTransaction(tx, [authority]);
    await conn.confirmTransaction(sig, "confirmed");
    console.log("pool initialized:", sig);
  } else {
    console.log("pool already initialized");
  }

  // 3. Verify
  const verify = await conn.getAccountInfo(pool);
  if (verify) {
    const decoded = decodeStakingPool(verify.data);
    console.log("--- pool state ---");
    console.log("authority:        ", decoded.authority.toBase58());
    console.log("kirite_mint:      ", decoded.kiriteMint.toBase58());
    console.log("kirite_vault:     ", decoded.kiriteVault.toBase58());
    console.log("fee_vault:        ", decoded.feeVault.toBase58());
    console.log("total_weight:     ", decoded.totalStakeWeight.toString());
    console.log("fee_vault_floor:  ", decoded.feeVaultFloor.toString());
  }

  console.log("\n✓ MAINNET STAKING POOL READY");
  console.log("Program:    ", STAKING_PROGRAM_ID.toBase58());
  console.log("Pool:       ", pool.toBase58());
  console.log("Solscan:    https://solscan.io/account/" + STAKING_PROGRAM_ID.toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
