/**
 * Verify the upgraded multipliers (1/1.5/2.5/4/8) by staking at 90d
 * with a fresh wallet. Old multiplier was 2.0x, new is 2.5x. The
 * resulting weight should be amount * 2.5.
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
} from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import {
  deriveStakingPool,
  deriveVaultAuthority,
  deriveStakeAccount,
  buildStakeIx,
  decodeStakeAccount,
} from "../sdk/src/staking.mjs";

const RPC =
  "https://devnet.helius-rpc.com/?api-key=8fc70926-95dc-4e72-8557-7245bd7e36fa";

function loadKp(p) {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8")))
  );
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const wallet = loadKp(`${os.homedir()}/.config/solana/id.json`);
  const state = JSON.parse(
    fs.readFileSync("./scripts/.staking-test-state.json", "utf-8")
  );
  const kiriteMint = new PublicKey(state.kiriteMint);

  const staker = Keypair.generate();
  console.log("test staker:", staker.publicKey.toBase58());

  // fund staker
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: staker.publicKey,
      lamports: 0.02 * LAMPORTS_PER_SOL,
    })
  );
  await connection.confirmTransaction(
    await connection.sendTransaction(fundTx, [wallet]),
    "confirmed"
  );

  // mint 200 KIRITE to staker
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
    200_000_000_000n
  );

  const [pool] = deriveStakingPool();
  const [vaultAuthority] = deriveVaultAuthority(pool);
  const [stakeAccount] = deriveStakeAccount(staker.publicKey);
  const kiriteVault = await getAssociatedTokenAddress(
    kiriteMint,
    vaultAuthority,
    true
  );

  // stake 200 KIRITE @ 90-day lock
  const amount = 200_000_000_000n;
  const tx = new Transaction().add(
    buildStakeIx({
      staker: staker.publicKey,
      stakerKirite: stakerAta.address,
      kiriteVault,
      amount,
      lockDays: 90,
    })
  );
  const sig = await connection.sendTransaction(tx, [staker]);
  await connection.confirmTransaction(sig, "confirmed");

  const sInfo = await connection.getAccountInfo(stakeAccount);
  const s = decodeStakeAccount(sInfo.data);

  const expectedNew = (amount * 250n) / 100n; // new multiplier 2.5x
  const expectedOld = (amount * 200n) / 100n; // old multiplier 2.0x

  console.log("amount:        ", amount.toString());
  console.log("weight:        ", s.weight.toString());
  console.log("expected (new):", expectedNew.toString(), "(2.5x, new multiplier)");
  console.log("expected (old):", expectedOld.toString(), "(2.0x, old multiplier)");

  if (s.weight === expectedNew) {
    console.log("\n✓ NEW multipliers active on devnet (2.5x for 90d)");
  } else if (s.weight === expectedOld) {
    console.log("\n✗ still using OLD multipliers — upgrade didn't take effect");
  } else {
    console.log("\n? unexpected weight");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
