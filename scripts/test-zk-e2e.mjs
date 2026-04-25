/**
 * KIRITE privacy v3 — end-to-end ZK shield-pool flow on devnet.
 *
 * Bootstraps a 0.01 SOL WSOL pool, makes a deposit, generates a real
 * Groth16 proof against the on-chain Merkle tree, and submits the
 * withdraw via the same wallet acting as the relayer. If the verifier
 * accepts, the recipient ATA balance increases.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAccount,
} from "@solana/spl-token";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  KIRITE_PROGRAM_ID,
  deriveShieldPool,
  deriveVaultAuthority,
  deriveProtocolConfig,
  deriveGovernance,
  buildInitializeProtocolIx,
  buildInitializeShieldPoolIx,
  buildDepositIx,
  buildWithdrawIx,
  decodeShieldPool,
  fetchPoolLeaves,
} from "../sdk/src/kirite-zk.mjs";
import {
  computeCommitment,
  computeNullifierHash,
  generateMembershipProof,
  randomFieldBytes,
  fieldToBE32,
  be32ToField,
  poseidonZeroHashes,
  buildMerkleProof,
} from "../sdk/src/zk.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DENOM_LAMPORTS = 5_000_000n; // 0.005 SOL — fresh pool to isolate from prior runs
const TIMELOCK_SECONDS = 600n;      // legacy field; validation still requires >= 600 even though withdraw no longer enforces
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";

const WASM_PATH = path.resolve(
  __dirname,
  "../circuits/build/membership_js/membership.wasm",
);
const ZKEY_PATH = path.resolve(
  __dirname,
  "../circuits/build/membership_final.zkey",
);

function loadWallet(file = `${os.homedir()}/.config/solana/id.json`) {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf-8"))),
  );
}

async function ensureProtocol(conn, payer) {
  const [protocolConfig] = deriveProtocolConfig();
  const info = await conn.getAccountInfo(protocolConfig);
  if (info) {
    console.log("protocol already initialized:", protocolConfig.toBase58());
    return protocolConfig;
  }
  console.log("initializing protocol…");
  const ix = buildInitializeProtocolIx({
    authority: payer.publicKey,
    treasury: payer.publicKey,
    feeBps: 10,
    burnRatioBps: 5000,
  });
  const tx = new Transaction().add(ix);
  const sig = await conn.sendTransaction(tx, [payer]);
  await conn.confirmTransaction(sig, "confirmed");
  console.log("  init_protocol tx:", sig);
  return protocolConfig;
}

async function ensurePool(conn, payer) {
  const [pool] = deriveShieldPool(NATIVE_MINT, DENOM_LAMPORTS);
  const [vaultAuthority] = deriveVaultAuthority(pool);
  const vault = await getAssociatedTokenAddress(NATIVE_MINT, vaultAuthority, true);
  const info = await conn.getAccountInfo(pool);
  if (info) {
    console.log("pool already initialized:", pool.toBase58());
    return { pool, vault };
  }

  // Vault must be a WSOL ATA owned by the vault_authority PDA.
  const vaultIx = createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey,
    vault,
    vaultAuthority,
    NATIVE_MINT,
  );
  console.log("creating WSOL vault ATA…");
  const vaultTx = new Transaction().add(vaultIx);
  const vaultSig = await conn.sendTransaction(vaultTx, [payer]);
  await conn.confirmTransaction(vaultSig, "confirmed");
  console.log("  vault tx:", vaultSig);

  console.log("initializing shield pool…");
  const poolIx = buildInitializeShieldPoolIx({
    operator: payer.publicKey,
    mint: NATIVE_MINT,
    vault,
    denomination: DENOM_LAMPORTS,
    timelockSeconds: TIMELOCK_SECONDS,
  });
  const poolTx = new Transaction().add(poolIx);
  const poolSig = await conn.sendTransaction(poolTx, [payer]);
  await conn.confirmTransaction(poolSig, "confirmed");
  console.log("  init_pool tx:", poolSig);
  return { pool, vault };
}

async function depositOne(conn, payer, pool, vault) {
  // Wrap exactly 0.01 SOL into the depositor's WSOL ATA.
  const ata = await getAssociatedTokenAddress(NATIVE_MINT, payer.publicKey);
  const ataInfo = await conn.getAccountInfo(ata);
  const wrapTx = new Transaction();
  if (!ataInfo) {
    wrapTx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        ata,
        payer.publicKey,
        NATIVE_MINT,
      ),
    );
  }
  wrapTx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: ata,
      lamports: Number(DENOM_LAMPORTS),
    }),
    createSyncNativeInstruction(ata),
  );
  const wrapSig = await conn.sendTransaction(wrapTx, [payer]);
  await conn.confirmTransaction(wrapSig, "confirmed");
  console.log("  wrap+sync tx:", wrapSig);

  // Fetch current pool to learn the leaf_index this deposit will land at.
  const poolInfo = await conn.getAccountInfo(pool);
  const decoded = decodeShieldPool(poolInfo.data);
  const leafIndex = decoded.nextLeafIndex;
  console.log("  leaf_index:", leafIndex);

  const ns = randomFieldBytes();
  const bf = randomFieldBytes();
  const commitment = await computeCommitment(ns, DENOM_LAMPORTS, bf, leafIndex);

  const depIx = buildDepositIx({
    depositor: payer.publicKey,
    depositorTokenAccount: ata,
    vault,
    shieldPool: pool,
    commitment,
  });
  const depTx = new Transaction().add(depIx);
  const sig = await conn.sendTransaction(depTx, [payer]);
  await conn.confirmTransaction(sig, "confirmed");
  console.log("  deposit tx:", sig);

  return { ns, bf, leafIndex, commitment };
}

async function fetchAllLeaves(conn, pool) {
  // We don't have a direct on-chain leaf list; we reconstruct from the
  // emitted DepositCommitted events. For the test, we just track
  // commitments produced in this run and pad with zero leaves.
  // This is sufficient because the only deposit in our pool is the one
  // we just made.
  return [];
}

async function withdrawOne(conn, payer, pool, vault, note) {
  const recipient = Keypair.generate();
  const recipientAta = await getAssociatedTokenAddress(
    NATIVE_MINT,
    recipient.publicKey,
  );
  const treasuryAta = await getAssociatedTokenAddress(
    NATIVE_MINT,
    payer.publicKey,
  );

  // Make sure recipient ATA exists; payer covers rent.
  const ataIx = createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey,
    recipientAta,
    recipient.publicKey,
    NATIVE_MINT,
  );
  const ataTx = new Transaction().add(ataIx);
  await conn.confirmTransaction(
    await conn.sendTransaction(ataTx, [payer]),
    "confirmed",
  );

  // Pull every prior deposit from program logs so the proof reconstructs
  // the same root the on-chain pool currently sees.
  console.log("scanning pool leaves from event log…");
  const allLeaves = await fetchPoolLeaves(conn, pool, { limit: 1000 });
  console.log(`  recovered ${allLeaves.length} leaf entries`);

  console.log("generating Groth16 proof…");
  const t0 = Date.now();
  const { proof, publicInputs } = await generateMembershipProof({
    nullifierSecret: note.ns,
    blindingFactor: note.bf,
    amount: DENOM_LAMPORTS,
    leafIndex: note.leafIndex,
    allLeaves,
    recipient: recipientAta,
    wasmPath: WASM_PATH,
    zkeyPath: ZKEY_PATH,
  });
  console.log(`  proof generated in ${Date.now() - t0}ms`);
  console.log("  root:           ", Buffer.from(publicInputs.root).toString("hex"));
  console.log("  nullifier_hash: ", Buffer.from(publicInputs.nullifierHash).toString("hex"));

  // Sanity: pool's current_root should match our reconstructed root.
  const poolInfo = await conn.getAccountInfo(pool);
  const decoded = decodeShieldPool(poolInfo.data);
  const onchainRoot = Buffer.from(decoded.currentRoot).toString("hex");
  const proofRoot = Buffer.from(publicInputs.root).toString("hex");
  console.log("  on-chain current_root:", onchainRoot);
  if (onchainRoot !== proofRoot) {
    throw new Error("root mismatch — Poseidon parity broken");
  }

  const wIx = buildWithdrawIx({
    relayer: payer.publicKey,
    recipientTokenAccount: recipientAta,
    treasuryTokenAccount: treasuryAta,
    mint: NATIVE_MINT,
    shieldPool: pool,
    vault,
    proof,
    nullifierHash: publicInputs.nullifierHash,
    proofRoot: publicInputs.root,
  });
  const wTx = new Transaction().add(wIx);
  const wSig = await conn.sendTransaction(wTx, [payer]);
  await conn.confirmTransaction(wSig, "confirmed");
  console.log("  withdraw tx:", wSig);

  const recipientAcc = await getAccount(conn, recipientAta);
  console.log("  recipient amount:", recipientAcc.amount.toString());
  if (recipientAcc.amount === 0n) {
    throw new Error("recipient received nothing");
  }
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const payer = loadWallet();
  console.log("payer:           ", payer.publicKey.toBase58());
  console.log("program:         ", KIRITE_PROGRAM_ID.toBase58());
  const balance = await conn.getBalance(payer.publicKey);
  console.log("payer SOL:       ", (balance / LAMPORTS_PER_SOL).toFixed(4));

  await ensureProtocol(conn, payer);
  const { pool, vault } = await ensurePool(conn, payer);
  console.log("pool:            ", pool.toBase58());
  console.log("vault (WSOL ATA):", vault.toBase58());

  const note = await depositOne(conn, payer, pool, vault);
  await withdrawOne(conn, payer, pool, vault, note);

  console.log("\n✓ ZK e2e succeeded");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
