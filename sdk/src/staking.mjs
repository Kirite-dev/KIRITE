// KIRITE staking SDK (manual ix encoding, no IDL dependency).
//
// We don't ship an Anchor IDL for the staking program because anchor-syn
// 0.30.1 fails to build under recent rustc. Instead we encode instructions
// directly using their Anchor 8-byte discriminators (sha256("global:<name>")[:8]).

import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createHash } from "node:crypto";

export const STAKING_PROGRAM_ID = new PublicKey(
  "8LKqyAx7Uuyu4PqwD7RRGhxjLj1GnPgaEzUu4RUitYt3"
);

// Match on-chain LOCK_OPTIONS: (days, multiplier_basis_points).
// Minimum lock = 30 days to filter hot-money positions.
export const LOCK_OPTIONS = [
  [30, 150],
  [90, 250],
  [180, 400],
  [365, 800],
];

// No entry fee — industry default. Kept as a constant so the UI can
// surface a non-zero amount if we ever introduce one.
export const ENTRY_FEE_LAMPORTS = 0n;

function discriminator(name) {
  const h = createHash("sha256").update(`global:${name}`).digest();
  return h.subarray(0, 8);
}

export function deriveStakingPool() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("staking_pool")],
    STAKING_PROGRAM_ID
  );
}

export function deriveVaultAuthority(pool) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority"), pool.toBuffer()],
    STAKING_PROGRAM_ID
  );
}

export function deriveFeeVault(pool) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fee_vault"), pool.toBuffer()],
    STAKING_PROGRAM_ID
  );
}

export function deriveStakeAccount(staker) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("stake_account"), staker.toBuffer()],
    STAKING_PROGRAM_ID
  );
}

function u64Le(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

function u32Le(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n);
  return buf;
}

export function buildInitializeIx({
  authority,
  kiriteMint,
  kiriteVault,
}) {
  const [pool] = deriveStakingPool();
  const [vaultAuthority] = deriveVaultAuthority(pool);
  const [feeVault] = deriveFeeVault(pool);

  const data = discriminator("initialize");

  return new TransactionInstruction({
    programId: STAKING_PROGRAM_ID,
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: kiriteMint, isSigner: false, isWritable: false },
      { pubkey: kiriteVault, isSigner: false, isWritable: false },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: feeVault, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildStakeIx({
  staker,
  stakerKirite,
  kiriteVault,
  amount,
  lockDays,
}) {
  const [pool] = deriveStakingPool();
  const [stakeAccount] = deriveStakeAccount(staker);
  const [feeVault] = deriveFeeVault(pool);

  const data = Buffer.concat([
    discriminator("stake"),
    u64Le(amount),
    u32Le(lockDays),
  ]);

  return new TransactionInstruction({
    programId: STAKING_PROGRAM_ID,
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: stakeAccount, isSigner: false, isWritable: true },
      { pubkey: stakerKirite, isSigner: false, isWritable: true },
      { pubkey: kiriteVault, isSigner: false, isWritable: true },
      { pubkey: feeVault, isSigner: false, isWritable: true },
      { pubkey: staker, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildClaimIx({ staker }) {
  const [pool] = deriveStakingPool();
  const [stakeAccount] = deriveStakeAccount(staker);
  const [feeVault] = deriveFeeVault(pool);

  const data = discriminator("claim");

  return new TransactionInstruction({
    programId: STAKING_PROGRAM_ID,
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: stakeAccount, isSigner: false, isWritable: true },
      { pubkey: feeVault, isSigner: false, isWritable: true },
      { pubkey: staker, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildUnstakeIx({
  staker,
  stakerKirite,
  kiriteVault,
}) {
  const [pool] = deriveStakingPool();
  const [stakeAccount] = deriveStakeAccount(staker);
  const [vaultAuthority] = deriveVaultAuthority(pool);
  const [feeVault] = deriveFeeVault(pool);

  const data = discriminator("unstake");

  return new TransactionInstruction({
    programId: STAKING_PROGRAM_ID,
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: stakeAccount, isSigner: false, isWritable: true },
      { pubkey: stakerKirite, isSigner: false, isWritable: true },
      { pubkey: kiriteVault, isSigner: false, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: feeVault, isSigner: false, isWritable: true },
      { pubkey: staker, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export const STAKING_POOL_DISCRIMINATOR_NAME = "StakingPool";
export const STAKE_ACCOUNT_DISCRIMINATOR_NAME = "StakeAccount";

// Decode a StakingPool account. Layout matches `#[account]` Anchor v0.30.1.
// Layout (after 8-byte discriminator):
//   authority: Pubkey (32)
//   kirite_mint: Pubkey (32)
//   kirite_vault: Pubkey (32)
//   fee_vault: Pubkey (32)
//   total_stake_weight: u128 (16)
//   acc_reward_per_weight: u128 (16)
//   last_accounted_lamports: u64 (8)
//   fee_vault_floor: u64 (8)
//   bump: u8 (1)
//   vault_authority_bump: u8 (1)
//   fee_vault_bump: u8 (1)
//   is_draining: bool (1)
//   drain_started_at: i64 (8)
//   claim_enabled: bool (1)
export function decodeStakingPool(buf) {
  let o = 8; // skip discriminator
  const read32 = () => {
    const v = new PublicKey(buf.subarray(o, o + 32));
    o += 32;
    return v;
  };
  const readU128 = () => {
    const v = buf.readBigUInt64LE(o) | (buf.readBigUInt64LE(o + 8) << 64n);
    o += 16;
    return v;
  };
  const readU64 = () => {
    const v = buf.readBigUInt64LE(o);
    o += 8;
    return v;
  };
  const readI64 = () => {
    const v = buf.readBigInt64LE(o);
    o += 8;
    return v;
  };
  const readU8 = () => {
    const v = buf.readUInt8(o);
    o += 1;
    return v;
  };
  const readBool = () => readU8() === 1;
  return {
    authority: read32(),
    kiriteMint: read32(),
    kiriteVault: read32(),
    feeVault: read32(),
    totalStakeWeight: readU128(),
    accRewardPerWeight: readU128(),
    lastAccountedLamports: readU64(),
    feeVaultFloor: readU64(),
    bump: readU8(),
    vaultAuthorityBump: readU8(),
    feeVaultBump: readU8(),
    isDraining: readBool(),
    drainStartedAt: readI64(),
    claimEnabled: readBool(),
  };
}

// StakeAccount layout:
//   owner: Pubkey (32)
//   amount: u64 (8)
//   weight: u128 (16)
//   lock_days: u32 (4)
//   stake_at: i64 (8)
//   last_acc: u128 (16)
//   unclaimed: u64 (8)
//   bump: u8 (1)
export function decodeStakeAccount(buf) {
  let o = 8;
  const read32 = () => {
    const v = new PublicKey(buf.subarray(o, o + 32));
    o += 32;
    return v;
  };
  const readU128 = () => {
    const v = buf.readBigUInt64LE(o) | (buf.readBigUInt64LE(o + 8) << 64n);
    o += 16;
    return v;
  };
  const readU64 = () => {
    const v = buf.readBigUInt64LE(o);
    o += 8;
    return v;
  };
  const readI64 = () => {
    const v = buf.readBigInt64LE(o);
    o += 8;
    return v;
  };
  const readU32 = () => {
    const v = buf.readUInt32LE(o);
    o += 4;
    return v;
  };
  const readU8 = () => {
    const v = buf.readUInt8(o);
    o += 1;
    return v;
  };
  return {
    owner: read32(),
    amount: readU64(),
    lockDays: readU32(),
    weight: readU128(),
    stakeAt: readI64(),
    lastAcc: readU128(),
    unclaimed: readU64(),
    bump: readU8(),
  };
}
