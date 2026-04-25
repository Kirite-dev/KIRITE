/**
 * E2E test for kirite-staking on devnet.
 *
 *   1. mint a fresh test KIRITE mint (9 decimals)
 *   2. mint 100k tokens to the staker
 *   3. create the pool's kirite_vault ATA owned by vault_authority PDA
 *   4. initialize the staking pool
 *   5. stake 1000 KIRITE with a 30-day lock
 *   6. simulate fee deposit: send 0.1 SOL to fee_vault
 *   7. claim: expect ~0.1 SOL out (only one staker, all weight is theirs)
 *   8. for unstake we'd need to wait 30 days, so we just print pool state
 *
 * Run with:
 *   node scripts/test-staking-e2e.mjs
 *
 * The script is non-destructive on rerun if the pool already exists; it
 * skips initialize and stakes additional tokens instead.
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
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import {
  STAKING_PROGRAM_ID,
  deriveStakingPool,
  deriveVaultAuthority,
  deriveFeeVault,
  deriveStakeAccount,
  buildInitializeIx,
  buildStakeIx,
  buildClaimIx,
  decodeStakingPool,
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

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  }
  return {};
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const wallet = loadKp(`${os.homedir()}/.config/solana/id.json`);
  console.log("payer:        ", wallet.publicKey.toBase58());
  const bal = await connection.getBalance(wallet.publicKey);
  console.log("balance:      ", (bal / LAMPORTS_PER_SOL).toFixed(4), "SOL");

  const state = loadState();

  // 1. KIRITE mint (devnet test mint, not the real one)
  let kiriteMint;
  if (state.kiriteMint) {
    kiriteMint = new PublicKey(state.kiriteMint);
    console.log("mint (cached):", kiriteMint.toBase58());
  } else {
    console.log("creating fresh test KIRITE mint...");
    kiriteMint = await createMint(
      connection,
      wallet,
      wallet.publicKey,
      null,
      9
    );
    console.log("mint:         ", kiriteMint.toBase58());
    state.kiriteMint = kiriteMint.toBase58();
    saveState(state);
  }

  // 2. staker = same wallet for test simplicity
  const staker = wallet;

  // staker ATA
  const stakerAta = await getOrCreateAssociatedTokenAccount(
    connection,
    wallet,
    kiriteMint,
    staker.publicKey
  );
  console.log("stakerAta:    ", stakerAta.address.toBase58());

  if (Number(stakerAta.amount) < 100_000_000_000_000n) {
    console.log("minting 100,000 KIRITE to staker...");
    await mintTo(
      connection,
      wallet,
      kiriteMint,
      stakerAta.address,
      wallet,
      100_000_000_000_000n // 100k * 10^9
    );
  } else {
    console.log("staker already has KIRITE, skipping mint");
  }

  // 3. pool vault (ATA owned by vault_authority PDA)
  const [pool] = deriveStakingPool();
  const [vaultAuthority] = deriveVaultAuthority(pool);
  const [feeVault] = deriveFeeVault(pool);
  const [stakeAccount] = deriveStakeAccount(staker.publicKey);
  console.log("pool:         ", pool.toBase58());
  console.log("vaultAuthority", vaultAuthority.toBase58());
  console.log("feeVault:     ", feeVault.toBase58());
  console.log("stakeAccount: ", stakeAccount.toBase58());

  const kiriteVault = await getAssociatedTokenAddress(
    kiriteMint,
    vaultAuthority,
    true // allowOwnerOffCurve = true for PDA owner
  );
  console.log("kiriteVault:  ", kiriteVault.toBase58());

  const vaultAcc = await connection.getAccountInfo(kiriteVault);
  if (!vaultAcc) {
    console.log("creating kirite_vault ATA...");
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        kiriteVault,
        vaultAuthority,
        kiriteMint
      )
    );
    const sig = await connection.sendTransaction(tx, [wallet]);
    await connection.confirmTransaction(sig, "confirmed");
    console.log("vault ATA tx:", sig);
  } else {
    console.log("vault ATA exists");
  }

  // 4. initialize pool (skip if already exists)
  const poolAcc = await connection.getAccountInfo(pool);
  if (!poolAcc) {
    console.log("initializing staking pool...");
    const ix = buildInitializeIx({
      authority: wallet.publicKey,
      kiriteMint,
      kiriteVault,
    });
    const tx = new Transaction().add(ix);
    const sig = await connection.sendTransaction(tx, [wallet]);
    await connection.confirmTransaction(sig, "confirmed");
    console.log("init tx:    ", sig);
  } else {
    console.log("pool already initialized");
  }

  // print pool state
  const pInfo = await connection.getAccountInfo(pool);
  const p = decodeStakingPool(pInfo.data);
  console.log("--- pool state ---");
  console.log("totalWeight:        ", p.totalStakeWeight.toString());
  console.log("accRewardPerWeight: ", p.accRewardPerWeight.toString());
  console.log("lastAccountedLamports:", p.lastAccountedLamports.toString());

  // 5. stake 1000 KIRITE with 30-day lock
  console.log("\nstaking 1000 KIRITE @ 30d lock...");
  const stakeIx = buildStakeIx({
    staker: staker.publicKey,
    stakerKirite: stakerAta.address,
    kiriteVault,
    amount: 1_000_000_000_000n, // 1000 * 1e9
    lockDays: 30,
  });
  const tx2 = new Transaction().add(stakeIx);
  const sig2 = await connection.sendTransaction(tx2, [staker]);
  await connection.confirmTransaction(sig2, "confirmed");
  console.log("stake tx:   ", sig2);

  const sInfo = await connection.getAccountInfo(stakeAccount);
  const s = decodeStakeAccount(sInfo.data);
  console.log("staked amount:", s.amount.toString());
  console.log("stake weight: ", s.weight.toString());
  console.log("lock days:    ", s.lockDays);

  // 6. simulate fee deposit (relayer would do this)
  const feeAmount = 0.1 * LAMPORTS_PER_SOL;
  console.log(`\nsimulating fee deposit: ${feeAmount / LAMPORTS_PER_SOL} SOL into fee_vault...`);
  const feeTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: feeVault,
      lamports: feeAmount,
    })
  );
  const feeSig = await connection.sendTransaction(feeTx, [wallet]);
  await connection.confirmTransaction(feeSig, "confirmed");
  console.log("fee deposit tx:", feeSig);

  const fvBal = await connection.getBalance(feeVault);
  console.log("fee_vault balance:", (fvBal / LAMPORTS_PER_SOL).toFixed(6), "SOL");

  // 7. claim
  console.log("\nclaiming rewards...");
  const balBefore = await connection.getBalance(staker.publicKey);
  const claimIx = buildClaimIx({ staker: staker.publicKey });
  const tx3 = new Transaction().add(claimIx);
  const sig3 = await connection.sendTransaction(tx3, [staker]);
  await connection.confirmTransaction(sig3, "confirmed");
  const balAfter = await connection.getBalance(staker.publicKey);
  console.log("claim tx:    ", sig3);
  console.log("net change:  ", ((balAfter - balBefore) / LAMPORTS_PER_SOL).toFixed(6), "SOL");

  const sInfo2 = await connection.getAccountInfo(stakeAccount);
  const s2 = decodeStakeAccount(sInfo2.data);
  console.log("unclaimed after:", s2.unclaimed.toString());

  console.log("\n✓ stake + fee + claim flow OK on devnet");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
