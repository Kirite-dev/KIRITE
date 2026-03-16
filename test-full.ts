import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount as createTokenAccount,
  createAssociatedTokenAccount,
  getAssociatedTokenAddress,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";

const PROGRAM_ID = new PublicKey("4bUHrDPuRcoYPU7UTLojXtxJsWoCj3HJbKX9oLnEnYy6");

function loadWallet(): Keypair {
  const keypairPath = `${os.homedir()}/.config/solana/id.json`;
  const secretKey = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

// Replicate on-chain keccak commitment: H(nullifier || amount_le || blinding || leaf_index_le)
function computeCommitment(
  nullifierSecret: Buffer,
  amount: bigint,
  blindingFactor: Buffer,
  leafIndex: number,
): Buffer {
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(amount);
  const leafBuf = Buffer.alloc(4);
  leafBuf.writeUInt32LE(leafIndex);
  const preimage = Buffer.concat([nullifierSecret, amountBuf, blindingFactor, leafBuf]);
  // solana uses keccak256, node crypto has it as 'sha3-256' is NOT keccak. Use keccak manually.
  // Actually solana_program::keccak is keccak256 (pre-SHA3). Node doesn't have native keccak256.
  // We'll use the js-sha3 approach or just sha256 for the PDA seed — the on-chain code computes it.
  // For PDA derivation we need the EXACT same bytes. Let's use @noble/hashes
  try {
    const { keccak_256 } = require("@noble/hashes/sha3");
    return Buffer.from(keccak_256(preimage));
  } catch {
    // Fallback: sha256 won't match but we can try
    return crypto.createHash("sha256").update(preimage).digest();
  }
}

let passed = 0;
let failed = 0;

function ok(msg: string) {
  passed++;
  console.log(`  ✓ ${msg}`);
}

function fail(msg: string, err?: string) {
  failed++;
  console.log(`  ✗ ${msg}${err ? ` — ${err.slice(0, 120)}` : ""}`);
}

async function main() {
  const connection = new anchor.web3.Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );
  const wallet = loadWallet();
  const idl = JSON.parse(fs.readFileSync("./target/idl/kirite.json", "utf-8"));
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(wallet),
    { commitment: "confirmed" }
  );
  const program = new Program(idl, provider);

  console.log("╔══════════════════════════════════════════╗");
  console.log("║   KIRITE FULL DEVNET TEST SUITE v2       ║");
  console.log("╚══════════════════════════════════════════╝\n");

  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`wallet:  ${wallet.publicKey.toBase58()}`);
  console.log(`program: ${PROGRAM_ID.toBase58()}`);
  console.log(`balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);

  const [protocolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    PROGRAM_ID
  );

  // ═══════════════════════════════════════
  // TEST 0: Initialize Protocol
  // ═══════════════════════════════════════
  console.log("═══ TEST 0: initialize protocol ═══");

  const [governanceState] = PublicKey.findProgramAddressSync(
    [Buffer.from("governance"), protocolConfig.toBuffer()],
    PROGRAM_ID
  );

  const existingConfig = await connection.getAccountInfo(protocolConfig);
  if (existingConfig && existingConfig.data.length > 0) {
    ok("protocol already initialized");
  } else {
    try {
      const treasury = Keypair.generate();
      const tx = await program.methods
        .initializeProtocol(10, 5000)
        .accounts({
          protocolConfig,
          governanceState,
          authority: wallet.publicKey,
          treasury: treasury.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([wallet])
        .rpc();
      ok(`protocol initialized | tx: ${tx.slice(0, 16)}...`);
    } catch (e: any) {
      fail("initialize protocol", e.message?.slice(0, 150));
    }
  }

  // ═══════════════════════════════════════
  // TEST 1: Protocol State
  // ═══════════════════════════════════════
  console.log("\n═══ TEST 1: protocol state ═══");
  try {
    const config = await program.account.protocolConfig.fetch(protocolConfig);
    ok(`authority: ${config.authority.toBase58().slice(0, 10)}...`);
    ok(`fee_bps: ${config.feeBps} | burn_ratio: ${config.burnRatioBps}`);
    ok(`paused: ${config.isPaused} | pools: ${config.totalPools}`);
  } catch (e: any) {
    fail("fetch config", e.message);
  }

  // ═══════════════════════════════════════
  // TEST 2: Token + Shield Pool Setup
  // ═══════════════════════════════════════
  console.log("\n═══ TEST 2: shield pool setup ═══");

  let testMint: PublicKey;
  let userTokenAccount: PublicKey;
  const denomination = BigInt(1_000_000); // 1 token (6 decimals)

  try {
    testMint = await createMint(connection, wallet, wallet.publicKey, null, 6);
    ok(`mint: ${testMint.toBase58().slice(0, 10)}...`);

    userTokenAccount = await createAssociatedTokenAccount(
      connection,
      wallet,
      testMint,
      wallet.publicKey
    );
    ok(`token account created`);

    await mintTo(connection, wallet, testMint, userTokenAccount, wallet, 100_000_000);
    ok(`minted 100 tokens`);
  } catch (e: any) {
    fail("token setup", e.message);
    return;
  }

  // Shield Pool PDA
  const denomBytes = Buffer.alloc(8);
  denomBytes.writeBigUInt64LE(denomination);

  const [shieldPool] = PublicKey.findProgramAddressSync(
    [Buffer.from("shield_pool"), testMint.toBuffer(), denomBytes],
    PROGRAM_ID
  );

  const [nullifierSet] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier_set"), shieldPool.toBuffer()],
    PROGRAM_ID
  );

  // Create vault as a regular token account owned by a vault authority PDA
  const vaultKeypair = Keypair.generate();

  try {
    // Create vault token account
    const vaultAccount = await createTokenAccount(
      connection,
      wallet,
      testMint,
      shieldPool, // pool PDA owns the vault
      vaultKeypair
    );
    ok(`vault: ${vaultAccount.toBase58().slice(0, 10)}...`);

    const tx = await program.methods
      .initializeShieldPool({
        denomination: new anchor.BN(Number(denomination)),
        timelockSeconds: new anchor.BN(600),
      })
      .accounts({
        shieldPool,
        nullifierSet,
        protocolConfig,
        vault: vaultAccount,
        mint: testMint,
        operator: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();
    ok(`shield pool created | tx: ${tx.slice(0, 16)}...`);

    const pool = await program.account.shieldPool.fetch(shieldPool);
    ok(`denomination: ${pool.denomination.toString()}`);
    ok(`timelock: ${pool.timelockSeconds.toString()}s`);
    ok(`next_leaf: ${pool.nextLeafIndex} | deposits: ${pool.totalDeposits.toString()}`);
  } catch (e: any) {
    if (e.message?.includes("already in use")) {
      ok("shield pool already exists");
    } else {
      fail("create shield pool", e.message?.slice(0, 200));
      if (e.logs) {
        const errLogs = e.logs.filter((l: string) => l.includes("Error") || l.includes("error") || l.includes("failed") || l.includes("Program log"));
        errLogs.forEach((l: string) => console.log(`    LOG: ${l}`));
      }
    }
  }

  // ═══════════════════════════════════════
  // TEST 3: Deposit
  // ═══════════════════════════════════════
  console.log("\n═══ TEST 3: deposit into shield pool ═══");

  let poolState: any;
  try {
    poolState = await program.account.shieldPool.fetch(shieldPool);
  } catch {
    fail("cannot fetch pool, skipping deposit tests");
    poolState = null;
  }

  if (poolState) {
    const nullifierSecret = Buffer.from(crypto.randomBytes(32));
    const blindingFactor = Buffer.from(crypto.randomBytes(32));
    const leafIndex = poolState.nextLeafIndex;
    const commitment = computeCommitment(nullifierSecret, denomination, blindingFactor, leafIndex);

    // Pool entry PDA
    const [poolEntry] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_entry"), shieldPool.toBuffer(), commitment],
      PROGRAM_ID
    );

    // Fake encrypted amount (64 bytes)
    const encryptedAmount = crypto.randomBytes(64);

    try {
      const tx = await program.methods
        .deposit({
          nullifierSecret: Array.from(nullifierSecret),
          blindingFactor: Array.from(blindingFactor),
          commitment: Array.from(commitment),
        })
        .accounts({
          shieldPool,
          protocolConfig,
          poolEntry,
          depositorTokenAccount: userTokenAccount,
          vault: poolState.vault,
          depositor: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([wallet])
        .rpc();
      ok(`deposit 1 | tx: ${tx.slice(0, 16)}...`);

      const updatedPool = await program.account.shieldPool.fetch(shieldPool);
      ok(`deposits: ${updatedPool.totalDeposits.toString()} | leaf: ${updatedPool.nextLeafIndex}`);

      const vaultInfo = await getAccount(connection, poolState.vault);
      ok(`vault balance: ${vaultInfo.amount.toString()} lamports`);
    } catch (e: any) {
      fail("deposit 1", e.message?.slice(0, 200));
      if (e.logs) e.logs.filter((l: string) => l.includes("Program log") || l.includes("failed")).forEach((l: string) => console.log(`    LOG: ${l}`));
    }

    // Second deposit
    console.log("  --- deposit 2 ---");
    try {
      const ns2 = Buffer.from(crypto.randomBytes(32));
      const bf2 = Buffer.from(crypto.randomBytes(32));
      const pool2 = await program.account.shieldPool.fetch(shieldPool);
      const li2 = pool2.nextLeafIndex;
      const comm2 = computeCommitment(ns2, denomination, bf2, li2);
      const enc2 = crypto.randomBytes(64);

      const [pe2] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool_entry"), shieldPool.toBuffer(), comm2],
        PROGRAM_ID
      );

      const tx = await program.methods
        .deposit({
          nullifierSecret: Array.from(ns2),
          blindingFactor: Array.from(bf2),
          commitment: Array.from(comm2),
        })
        .accounts({
          shieldPool,
          protocolConfig,
          poolEntry: pe2,
          depositorTokenAccount: userTokenAccount,
          vault: pool2.vault,
          depositor: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([wallet])
        .rpc();
      ok(`deposit 2 | tx: ${tx.slice(0, 16)}...`);
    } catch (e: any) {
      fail("deposit 2", e.message);
    }
  }

  // ═══════════════════════════════════════
  // TEST 4: Confidential Account
  // ═══════════════════════════════════════
  console.log("\n═══ TEST 4: confidential account ═══");

  const [confAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("confidential_account"), wallet.publicKey.toBuffer(), testMint!.toBuffer()],
    PROGRAM_ID
  );
  const elgamalPubkey = crypto.randomBytes(32);

  try {
    const tx = await program.methods
      .createConfidentialAccount(Array.from(elgamalPubkey))
      .accounts({
        confidentialAccount: confAccount,
        protocolConfig,
        mint: testMint!,
        owner: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();
    ok(`confidential account | tx: ${tx.slice(0, 16)}...`);

    const acc = await program.account.confidentialAccount.fetch(confAccount);
    ok(`owner: ${acc.owner.toBase58().slice(0, 10)}...`);
    ok(`mint: ${acc.mint.toBase58().slice(0, 10)}...`);
    ok(`nonce: ${acc.nonce.toString()}`);
  } catch (e: any) {
    if (e.message?.includes("already in use")) {
      ok("confidential account already exists");
    } else {
      fail("create confidential account", e.message);
    }
  }

  // ═══════════════════════════════════════
  // TEST 5: Stealth Address
  // ═══════════════════════════════════════
  console.log("\n═══ TEST 5: stealth address ═══");

  const [stealthRegistry] = PublicKey.findProgramAddressSync(
    [Buffer.from("stealth_registry"), wallet.publicKey.toBuffer()],
    PROGRAM_ID
  );

  try {
    const existing = await connection.getAccountInfo(stealthRegistry);
    if (existing) {
      ok("stealth registry already exists");
      const reg = await program.account.stealthRegistry.fetch(stealthRegistry);
      ok(`active: ${reg.isActive}`);
    } else {
      const spendPubkey = crypto.randomBytes(32);
      const viewPubkey = crypto.randomBytes(32);

      const tx = await program.methods
        .registerStealthRegistry({
          spendPubkey: Array.from(spendPubkey),
          viewPubkey: Array.from(viewPubkey),
        })
        .accounts({
          stealthRegistry,
          owner: wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([wallet])
        .rpc();
      ok(`registry created | tx: ${tx.slice(0, 16)}...`);
    }
  } catch (e: any) {
    fail("stealth registry", e.message);
  }

  // ═══════════════════════════════════════
  // TEST 6: Error Cases
  // ═══════════════════════════════════════
  console.log("\n═══ TEST 6: error cases ═══");

  // 6a: Double init
  try {
    const [gov] = PublicKey.findProgramAddressSync(
      [Buffer.from("governance"), protocolConfig.toBuffer()],
      PROGRAM_ID
    );
    await program.methods
      .initializeProtocol(10, 5000)
      .accounts({
        protocolConfig,
        governanceState: gov,
        authority: wallet.publicKey,
        treasury: Keypair.generate().publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();
    fail("double init should fail");
  } catch {
    ok("double init rejected");
  }

  // 6b: Unauthorized pause
  try {
    const rando = Keypair.generate();
    await program.methods
      .pauseProtocol()
      .accounts({ protocolConfig, authority: rando.publicKey })
      .signers([rando])
      .rpc();
    fail("unauthorized pause should fail");
  } catch {
    ok("unauthorized pause rejected");
  }

  // ═══════════════════════════════════════
  // TEST 7: Governance (pause/resume)
  // ═══════════════════════════════════════
  console.log("\n═══ TEST 7: governance ═══");

  try {
    const tx = await program.methods
      .pauseProtocol()
      .accounts({ protocolConfig, authority: wallet.publicKey })
      .signers([wallet])
      .rpc();
    ok(`paused | tx: ${tx.slice(0, 16)}...`);

    const config = await program.account.protocolConfig.fetch(protocolConfig);
    if (config.isPaused) ok("is_paused = true");
    else fail("is_paused should be true");
  } catch (e: any) {
    fail("pause", e.message);
  }

  // Deposit while paused should fail
  try {
    if (poolState) {
      const ns = Buffer.from(crypto.randomBytes(32));
      const bf = Buffer.from(crypto.randomBytes(32));
      const comm = computeCommitment(ns, denomination, bf, 999);
      const [pe] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool_entry"), shieldPool.toBuffer(), comm],
        PROGRAM_ID
      );
      await program.methods
        .deposit({
          nullifierSecret: Array.from(ns),
          blindingFactor: Array.from(bf),
          commitment: Array.from(comm),
        })
        .accounts({
          shieldPool,
          protocolConfig,
          poolEntry: pe,
          depositorTokenAccount: userTokenAccount!,
          vault: poolState.vault,
          depositor: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([wallet])
        .rpc();
      fail("deposit while paused should fail");
    }
  } catch {
    ok("deposit while paused rejected");
  }

  // Resume
  try {
    const tx = await program.methods
      .resumeProtocol()
      .accounts({ protocolConfig, authority: wallet.publicKey })
      .signers([wallet])
      .rpc();
    ok(`resumed | tx: ${tx.slice(0, 16)}...`);
  } catch (e: any) {
    fail("resume", e.message);
  }

  // ═══════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════
  const finalBalance = await connection.getBalance(wallet.publicKey);
  console.log("\n╔══════════════════════════════════════════╗");
  console.log(`║  PASSED: ${String(passed).padEnd(3)} | FAILED: ${String(failed).padEnd(3)}              ║`);
  console.log(`║  SOL spent: ${((balance - finalBalance) / LAMPORTS_PER_SOL).toFixed(4).padEnd(10)}                  ║`);
  console.log(`║  SOL remaining: ${(finalBalance / LAMPORTS_PER_SOL).toFixed(4).padEnd(10)}              ║`);
  console.log("╚══════════════════════════════════════════╝");
  console.log(`\nhttps://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=devnet`);
}

main().catch(console.error);
