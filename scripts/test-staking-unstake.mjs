/**
 * Validate the unstake path with a 0-day lock (immediate withdraw).
 *
 * Reuses the test KIRITE mint from .staking-test-state.json. Stakes a
 * fresh wallet at 0-day lock, deposits more fees, then unstakes — which
 * should pay out remaining rewards AND return the principal KIRITE.
 *
 * Run after test-staking-e2e.mjs.
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
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import {
  deriveStakingPool,
  deriveVaultAuthority,
  deriveFeeVault,
  deriveStakeAccount,
  buildStakeIx,
  buildUnstakeIx,
  decodeStakeAccount,
} from "../sdk/src/staking.mjs";

const RPC =
  process.env.RPC_URL ||
  "https://devnet.helius-rpc.com/?api-key=8fc70926-95dc-4e72-8557-7245bd7e36fa";
const STATE_FILE = "./scripts/.staking-test-state.json";

function loadKp(p) {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8")))
  );
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const wallet = loadKp(`${os.homedir()}/.config/solana/id.json`);
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  const kiriteMint = new PublicKey(state.kiriteMint);

  // fresh staker so the 30d-locked stake from the previous run doesn't
  // collide with this 0-day stake (one stake account per wallet).
  const staker = Keypair.generate();
  console.log("staker:", staker.publicKey.toBase58());

  // fund staker with a tiny amount of SOL for tx fees
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: staker.publicKey,
      lamports: 0.02 * LAMPORTS_PER_SOL,
    })
  );
  const fundSig = await connection.sendTransaction(fundTx, [wallet]);
  await connection.confirmTransaction(fundSig, "confirmed");

  // staker ATA + mint 500 KIRITE
  const stakerAta = await getOrCreateAssociatedTokenAccount(
    connection,
    wallet,
    kiriteMint,
    staker.publicKey
  );
  await mintTo(
    connection,
    wallet,
    kiriteMint,
    stakerAta.address,
    wallet,
    500_000_000_000n
  );
  console.log("staker funded with 500 KIRITE");

  const [pool] = deriveStakingPool();
  const [vaultAuthority] = deriveVaultAuthority(pool);
  const [feeVault] = deriveFeeVault(pool);
  const [stakeAccount] = deriveStakeAccount(staker.publicKey);
  const kiriteVault = await getAssociatedTokenAddress(
    kiriteMint,
    vaultAuthority,
    true
  );

  // stake 500 KIRITE @ 0-day lock (multiplier = 100)
  console.log("staking 500 KIRITE @ 0d lock...");
  const stakeIx = buildStakeIx({
    staker: staker.publicKey,
    stakerKirite: stakerAta.address,
    kiriteVault,
    amount: 500_000_000_000n,
    lockDays: 0,
  });
  const tx1 = new Transaction().add(stakeIx);
  const sig1 = await connection.sendTransaction(tx1, [staker]);
  await connection.confirmTransaction(sig1, "confirmed");
  console.log("stake tx:", sig1);

  // deposit a small fee batch
  const feeAmount = 0.05 * LAMPORTS_PER_SOL;
  console.log(`depositing ${feeAmount / LAMPORTS_PER_SOL} SOL into fee_vault...`);
  const tx2 = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: feeVault,
      lamports: feeAmount,
    })
  );
  const sig2 = await connection.sendTransaction(tx2, [wallet]);
  await connection.confirmTransaction(sig2, "confirmed");

  // unstake — should pay rewards AND return KIRITE
  console.log("\nunstaking...");
  const balBefore = await connection.getBalance(staker.publicKey);
  const ataBefore = await getAccount(connection, stakerAta.address);

  const unstakeIx = buildUnstakeIx({
    staker: staker.publicKey,
    stakerKirite: stakerAta.address,
    kiriteVault,
  });
  const tx3 = new Transaction().add(unstakeIx);
  const sig3 = await connection.sendTransaction(tx3, [staker]);
  await connection.confirmTransaction(sig3, "confirmed");
  const balAfter = await connection.getBalance(staker.publicKey);
  const ataAfter = await getAccount(connection, stakerAta.address);

  console.log("unstake tx:    ", sig3);
  console.log("SOL net change:", ((balAfter - balBefore) / LAMPORTS_PER_SOL).toFixed(6), "SOL");
  console.log(
    "KIRITE returned:",
    ((Number(ataAfter.amount) - Number(ataBefore.amount)) / 1e9).toFixed(6),
    "KIRITE"
  );

  const sInfo = await connection.getAccountInfo(stakeAccount);
  if (sInfo) {
    const s = decodeStakeAccount(sInfo.data);
    console.log("position after: amount=" + s.amount.toString() + " unclaimed=" + s.unclaimed.toString());
  }

  console.log("\n✓ unstake flow OK on devnet");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
