/**
 * KIRITE Protocol — Migration Script
 *
 * Initializes the protocol on-chain after deployment:
 *   1. Initialize protocol config (authority, fee params)
 *   2. Add supported mints (SOL wrapped, USDC, USDT)
 *   3. Create initial shield pools for each mint
 *   4. Set governance parameters
 *
 * Usage:
 *   npx ts-node scripts/migrate.ts --cluster devnet
 *   npx ts-node scripts/migrate.ts --cluster mainnet-beta --wallet ~/.config/solana/mainnet.json
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as toml from "toml";

// -------------------------------------------------------------------------- //
// Configuration
// -------------------------------------------------------------------------- //

/** Mainnet token mints */
const MINTS = {
  SOL: NATIVE_MINT, // So11111111111111111111111111111111111111112
  USDC: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  USDT: new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
};

/** Shield pool configurations per mint */
interface PoolSpec {
  mint: PublicKey;
  symbol: string;
  denomination: anchor.BN;
  timelockSeconds: anchor.BN;
}

const DEVNET_POOLS: PoolSpec[] = [
  {
    mint: MINTS.SOL,
    symbol: "SOL",
    denomination: new anchor.BN(0.1 * LAMPORTS_PER_SOL), // 0.1 SOL
    timelockSeconds: new anchor.BN(300), // 5 minutes
  },
  {
    mint: MINTS.SOL,
    symbol: "SOL",
    denomination: new anchor.BN(1 * LAMPORTS_PER_SOL), // 1 SOL
    timelockSeconds: new anchor.BN(300),
  },
  {
    mint: MINTS.USDC,
    symbol: "USDC",
    denomination: new anchor.BN(100 * 1_000_000), // 100 USDC (6 decimals)
    timelockSeconds: new anchor.BN(300),
  },
  {
    mint: MINTS.USDT,
    symbol: "USDT",
    denomination: new anchor.BN(100 * 1_000_000), // 100 USDT (6 decimals)
    timelockSeconds: new anchor.BN(300),
  },
];

const MAINNET_POOLS: PoolSpec[] = [
  {
    mint: MINTS.SOL,
    symbol: "SOL",
    denomination: new anchor.BN(0.1 * LAMPORTS_PER_SOL),
    timelockSeconds: new anchor.BN(3600), // 1 hour
  },
  {
    mint: MINTS.SOL,
    symbol: "SOL",
    denomination: new anchor.BN(1 * LAMPORTS_PER_SOL),
    timelockSeconds: new anchor.BN(3600),
  },
  {
    mint: MINTS.SOL,
    symbol: "SOL",
    denomination: new anchor.BN(10 * LAMPORTS_PER_SOL),
    timelockSeconds: new anchor.BN(7200), // 2 hours
  },
  {
    mint: MINTS.USDC,
    symbol: "USDC",
    denomination: new anchor.BN(100 * 1_000_000),
    timelockSeconds: new anchor.BN(3600),
  },
  {
    mint: MINTS.USDC,
    symbol: "USDC",
    denomination: new anchor.BN(1000 * 1_000_000),
    timelockSeconds: new anchor.BN(7200),
  },
  {
    mint: MINTS.USDC,
    symbol: "USDC",
    denomination: new anchor.BN(10000 * 1_000_000),
    timelockSeconds: new anchor.BN(14400), // 4 hours
  },
  {
    mint: MINTS.USDT,
    symbol: "USDT",
    denomination: new anchor.BN(100 * 1_000_000),
    timelockSeconds: new anchor.BN(3600),
  },
  {
    mint: MINTS.USDT,
    symbol: "USDT",
    denomination: new anchor.BN(1000 * 1_000_000),
    timelockSeconds: new anchor.BN(7200),
  },
];

/** Protocol fee parameters */
const FEE_BPS = 10; // 0.1%
const BURN_RATIO_BPS = 5000; // 50% of fees burned

// -------------------------------------------------------------------------- //
// CLI argument parsing
// -------------------------------------------------------------------------- //

function parseArgs(): { cluster: string; wallet: string; dryRun: boolean } {
  const args = process.argv.slice(2);
  let cluster = "devnet";
  let wallet = `${process.env.HOME || process.env.USERPROFILE}/.config/solana/id.json`;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--cluster":
      case "-c":
        cluster = args[++i];
        break;
      case "--wallet":
      case "-w":
        wallet = args[++i];
        break;
      case "--dry-run":
        dryRun = true;
        break;
    }
  }

  return { cluster, wallet, dryRun };
}

// -------------------------------------------------------------------------- //
// Utilities
// -------------------------------------------------------------------------- //

function loadKeypair(filepath: string): Keypair {
  const resolved = filepath.replace("~", process.env.HOME || process.env.USERPROFILE || "");
  const raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function getRpcUrl(cluster: string): string {
  // Check for deploy.toml overrides
  const tomlPath = path.join(__dirname, "..", "app", "deploy.toml");
  if (fs.existsSync(tomlPath)) {
    try {
      const config = toml.parse(fs.readFileSync(tomlPath, "utf-8"));
      const clusterKey = cluster.replace("-", "_");
      if (config[clusterKey]?.rpc_url) {
        return config[clusterKey].rpc_url;
      }
    } catch {
      // Fall through to defaults
    }
  }

  switch (cluster) {
    case "devnet":
      return clusterApiUrl("devnet");
    case "testnet":
      return clusterApiUrl("testnet");
    case "mainnet-beta":
      return clusterApiUrl("mainnet-beta");
    default:
      return "http://localhost:8899";
  }
}

function loadProgramId(): PublicKey {
  // Try Anchor.toml first
  const anchorToml = path.join(__dirname, "..", "Anchor.toml");
  if (fs.existsSync(anchorToml)) {
    const content = fs.readFileSync(anchorToml, "utf-8");
    const config = toml.parse(content);
    // Check all cluster configs for program ID
    for (const clusterName of ["mainnet", "devnet", "localnet"]) {
      const id = config?.programs?.[clusterName]?.kirite;
      if (id && !id.includes("11111111111")) {
        return new PublicKey(id);
      }
    }
  }

  // Try keypair file
  const keypairPath = path.join(__dirname, "..", "target", "deploy", "kirite-keypair.json");
  if (fs.existsSync(keypairPath)) {
    const kp = loadKeypair(keypairPath);
    return kp.publicKey;
  }

  throw new Error("Cannot determine program ID. Update Anchor.toml or provide target/deploy/kirite-keypair.json");
}

function findPDA(programId: PublicKey, seeds: Buffer[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

class Logger {
  private step = 0;

  section(title: string) {
    console.log("");
    console.log("=".repeat(60));
    console.log(`  ${title}`);
    console.log("=".repeat(60));
  }

  info(msg: string) {
    console.log(`  [INFO]  ${msg}`);
  }

  ok(msg: string) {
    console.log(`  [OK]    ${msg}`);
  }

  warn(msg: string) {
    console.log(`  [WARN]  ${msg}`);
  }

  error(msg: string) {
    console.error(`  [ERROR] ${msg}`);
  }

  stepStart(msg: string) {
    this.step++;
    console.log(`\n  Step ${this.step}: ${msg}`);
  }

  tx(sig: string) {
    console.log(`          tx: ${sig}`);
  }
}

// -------------------------------------------------------------------------- //
// Migration steps
// -------------------------------------------------------------------------- //

async function initializeProtocol(
  program: anchor.Program,
  authority: Keypair,
  log: Logger,
  dryRun: boolean
): Promise<void> {
  log.stepStart("Initialize protocol config");

  const [configPda] = findPDA(program.programId, [Buffer.from("protocol_config")]);
  log.info(`Protocol config PDA: ${configPda.toBase58()}`);

  // Check if already initialized
  try {
    const existing = await program.account.protocolConfig.fetch(configPda);
    if (existing) {
      log.warn("Protocol config already initialized. Skipping.");
      log.info(`  Authority: ${existing.authority.toBase58()}`);
      log.info(`  Fee: ${existing.feeBps} bps`);
      log.info(`  Burn ratio: ${existing.burnRatioBps} bps`);
      return;
    }
  } catch {
    // Account doesn't exist — proceed with initialization
  }

  if (dryRun) {
    log.info(`[DRY RUN] Would initialize with fee=${FEE_BPS}bps, burn=${BURN_RATIO_BPS}bps`);
    return;
  }

  const tx = await program.methods
    .initializeProtocol(FEE_BPS, BURN_RATIO_BPS)
    .accounts({
      authority: authority.publicKey,
      protocolConfig: configPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();

  log.ok(`Protocol initialized`);
  log.tx(tx);
}

async function addSupportedMints(
  program: anchor.Program,
  authority: Keypair,
  log: Logger,
  dryRun: boolean
): Promise<void> {
  log.stepStart("Add supported token mints");

  const [configPda] = findPDA(program.programId, [Buffer.from("protocol_config")]);

  for (const [symbol, mint] of Object.entries(MINTS)) {
    log.info(`Adding ${symbol}: ${mint.toBase58()}`);

    // Check if already added
    try {
      const config = await program.account.protocolConfig.fetch(configPda);
      const alreadyAdded = config.supportedMints.some(
        (m: PublicKey) => m.toBase58() === mint.toBase58()
      );
      if (alreadyAdded) {
        log.warn(`${symbol} already in supported mints. Skipping.`);
        continue;
      }
    } catch {
      // Proceed
    }

    if (dryRun) {
      log.info(`[DRY RUN] Would add ${symbol} (${mint.toBase58()})`);
      continue;
    }

    try {
      const tx = await program.methods
        .addSupportedMint()
        .accounts({
          authority: authority.publicKey,
          protocolConfig: configPda,
          mint: mint,
        })
        .signers([authority])
        .rpc();

      log.ok(`Added ${symbol}`);
      log.tx(tx);
    } catch (err: any) {
      log.error(`Failed to add ${symbol}: ${err.message}`);
    }
  }
}

async function createShieldPools(
  program: anchor.Program,
  authority: Keypair,
  cluster: string,
  log: Logger,
  dryRun: boolean
): Promise<void> {
  log.stepStart("Create shield pools");

  const pools = cluster === "mainnet-beta" ? MAINNET_POOLS : DEVNET_POOLS;
  const [configPda] = findPDA(program.programId, [Buffer.from("protocol_config")]);

  for (const pool of pools) {
    const denomDisplay =
      pool.symbol === "SOL"
        ? `${pool.denomination.toNumber() / LAMPORTS_PER_SOL} ${pool.symbol}`
        : `${pool.denomination.toNumber() / 1_000_000} ${pool.symbol}`;

    log.info(`Creating pool: ${denomDisplay} (timelock: ${pool.timelockSeconds}s)`);

    const denominationBytes = pool.denomination.toArrayLike(Buffer, "le", 8);
    const [poolPda] = findPDA(program.programId, [
      Buffer.from("shield_pool"),
      pool.mint.toBuffer(),
      denominationBytes,
    ]);

    // Check if pool already exists
    try {
      const existing = await program.account.shieldPool.fetch(poolPda);
      if (existing) {
        log.warn(`Pool ${denomDisplay} already exists at ${poolPda.toBase58()}. Skipping.`);
        continue;
      }
    } catch {
      // Proceed
    }

    // Derive vault and vault authority PDAs
    const [vaultAuthority, vaultAuthorityBump] = findPDA(program.programId, [
      Buffer.from("vault_authority"),
      poolPda.toBuffer(),
    ]);

    const vault = await getAssociatedTokenAddress(pool.mint, vaultAuthority, true);

    // Derive nullifier set PDA
    const [nullifierSet] = findPDA(program.programId, [
      Buffer.from("nullifier_set"),
      poolPda.toBuffer(),
    ]);

    if (dryRun) {
      log.info(`[DRY RUN] Would create pool at ${poolPda.toBase58()}`);
      continue;
    }

    try {
      const tx = await program.methods
        .initializeShieldPool({
          denomination: pool.denomination,
          timelockSeconds: pool.timelockSeconds,
        })
        .accounts({
          authority: authority.publicKey,
          protocolConfig: configPda,
          shieldPool: poolPda,
          mint: pool.mint,
          vault: vault,
          vaultAuthority: vaultAuthority,
          nullifierSet: nullifierSet,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([authority])
        .rpc();

      log.ok(`Pool created: ${denomDisplay} -> ${poolPda.toBase58()}`);
      log.tx(tx);
    } catch (err: any) {
      log.error(`Failed to create pool ${denomDisplay}: ${err.message}`);
    }
  }
}

async function setupGovernance(
  program: anchor.Program,
  authority: Keypair,
  cluster: string,
  log: Logger,
  dryRun: boolean
): Promise<void> {
  log.stepStart("Configure governance");

  const [configPda] = findPDA(program.programId, [Buffer.from("protocol_config")]);
  const [governancePda] = findPDA(program.programId, [Buffer.from("governance_state")]);

  log.info(`Governance PDA: ${governancePda.toBase58()}`);

  // On devnet, use single signer. On mainnet, require multi-sig setup separately.
  if (cluster === "mainnet-beta") {
    log.warn("Mainnet governance requires multi-sig setup.");
    log.warn("Transfer upgrade authority to Squads multisig after deployment.");
    log.warn("Skipping automated governance setup for mainnet.");
    return;
  }

  // Check if governance is already set up
  try {
    const existing = await program.account.governanceState.fetch(governancePda);
    if (existing) {
      log.warn("Governance state already initialized. Skipping.");
      log.info(`  Required signers: ${existing.requiredSigners}`);
      return;
    }
  } catch {
    // Proceed
  }

  if (dryRun) {
    log.info("[DRY RUN] Would set up governance with single signer");
    return;
  }

  try {
    const signers = [authority.publicKey];
    // Pad with default pubkeys to fill the 7-element array
    while (signers.length < 7) {
      signers.push(PublicKey.default);
    }

    const tx = await program.methods
      .updateGovernanceSigners(signers, 1)
      .accounts({
        authority: authority.publicKey,
        protocolConfig: configPda,
        governanceState: governancePda,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    log.ok("Governance configured (1-of-1 signer for devnet)");
    log.tx(tx);
  } catch (err: any) {
    log.error(`Failed to set up governance: ${err.message}`);
  }
}

// -------------------------------------------------------------------------- //
// Main
// -------------------------------------------------------------------------- //

async function main() {
  const { cluster, wallet, dryRun } = parseArgs();
  const log = new Logger();

  log.section("KIRITE Protocol Migration");
  log.info(`Cluster:  ${cluster}`);
  log.info(`Wallet:   ${wallet}`);
  log.info(`Dry run:  ${dryRun}`);

  // Load authority keypair
  const authority = loadKeypair(wallet);
  log.info(`Authority: ${authority.publicKey.toBase58()}`);

  // Set up connection and provider
  const rpcUrl = getRpcUrl(cluster);
  log.info(`RPC URL:   ${rpcUrl}`);

  const connection = new Connection(rpcUrl, "confirmed");
  const anchorWallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(connection, anchorWallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  // Load program
  const programId = loadProgramId();
  log.info(`Program ID: ${programId.toBase58()}`);

  const idlPath = path.join(__dirname, "..", "target", "idl", "kirite.json");
  if (!fs.existsSync(idlPath)) {
    log.error(`IDL not found at ${idlPath}. Run 'anchor build' first.`);
    process.exit(1);
  }

  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, programId, provider);

  // Check balance
  const balance = await connection.getBalance(authority.publicKey);
  log.info(`Authority balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < 0.5 * LAMPORTS_PER_SOL) {
    log.error("Insufficient balance. Need at least 0.5 SOL for migration transactions.");
    if (cluster === "devnet") {
      log.info("Request airdrop: solana airdrop 2 --url devnet");
    }
    process.exit(1);
  }

  // Execute migration steps
  try {
    await initializeProtocol(program, authority, log, dryRun);
    await addSupportedMints(program, authority, log, dryRun);
    await createShieldPools(program, authority, cluster, log, dryRun);
    await setupGovernance(program, authority, cluster, log, dryRun);
  } catch (err: any) {
    log.error(`Migration failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  }

  // Summary
  log.section("Migration Complete");

  const [configPda] = findPDA(programId, [Buffer.from("protocol_config")]);
  log.info(`Protocol config: ${configPda.toBase58()}`);
  log.info(`Program ID:      ${programId.toBase58()}`);
  log.info(`Cluster:         ${cluster}`);

  if (!dryRun) {
    try {
      const config = await program.account.protocolConfig.fetch(configPda);
      log.info(`Fee:             ${config.feeBps} bps (${(config.feeBps as number) / 100}%)`);
      log.info(`Burn ratio:      ${config.burnRatioBps} bps (${(config.burnRatioBps as number) / 100}%)`);
      log.info(`Supported mints: ${(config.supportedMints as PublicKey[]).length}`);
      log.info(`Total pools:     ${config.totalPools}`);
    } catch {
      log.warn("Could not fetch final protocol config state.");
    }
  }

  // Save migration receipt
  const receiptDir = path.join(__dirname, "..", "deployments", cluster);
  fs.mkdirSync(receiptDir, { recursive: true });
  const receiptPath = path.join(receiptDir, `migration-${Date.now()}.json`);
  fs.writeFileSync(
    receiptPath,
    JSON.stringify(
      {
        programId: programId.toBase58(),
        cluster,
        authority: authority.publicKey.toBase58(),
        feeBps: FEE_BPS,
        burnRatioBps: BURN_RATIO_BPS,
        mints: Object.fromEntries(
          Object.entries(MINTS).map(([k, v]) => [k, v.toBase58()])
        ),
        timestamp: new Date().toISOString(),
        dryRun,
      },
      null,
      2
    )
  );

  log.ok(`Migration receipt saved to ${receiptPath}`);
  console.log("");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
// migrate rev #26
