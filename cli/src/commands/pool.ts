import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { KiriteClient } from "@kirite/sdk";
import { loadConfig } from "../utils/config";
import {
  printBanner,
  printHeader,
  printField,
  printSuccess,
  printError,
  printInfo,
  printTable,
  printPoolState,
  formatAmount,
  shortenPubkey,
  formatHex,
  spinnerMessage,
} from "../utils/display";
import chalk from "chalk";

/**
 * Registers the `kirite pool` command group.
 */
export function registerPoolCommand(program: Command): void {
  const poolCmd = program
    .command("pool")
    .description("Shield pool information and management");

  // kirite pool info <address>
  poolCmd
    .command("info <address>")
    .description("Show detailed information about a shield pool")
    .action(async (address: string) => {
      printBanner();

      try {
        const config = loadConfig();
        const client = new KiriteClient({
          endpoint: config.endpoint,
          commitment: config.commitment,
        });

        await client.connect();

        const poolId = new PublicKey(address);

        const spinner = spinnerMessage("Fetching pool state...");
        spinner.start();

        const poolState = await client.getPoolState(poolId);

        spinner.stop(true);

        printPoolState(poolState);

        // Calculate utilization
        const capacity = 2 ** poolState.treeDepth;
        const utilization = (poolState.nextLeafIndex / capacity) * 100;

        printHeader("Statistics");
        printField("Utilization", `${utilization.toFixed(2)}%`);

        const netDeposits = poolState.totalDeposits.sub(
          poolState.totalWithdrawals
        );
        printField("Net Deposits", formatAmount(netDeposits));
        printField("Merkle Root", formatHex(poolState.merkleRoot));
        console.log();
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // kirite pool list
  poolCmd
    .command("list")
    .description("List all shield pools")
    .option("--mint <address>", "Filter by token mint")
    .action(async (opts) => {
      printBanner();

      try {
        const config = loadConfig();
        const client = new KiriteClient({
          endpoint: config.endpoint,
          commitment: config.commitment,
        });

        await client.connect();

        const spinner = spinnerMessage("Fetching pools...");
        spinner.start();

        let pools;
        if (opts.mint) {
          const mint = new PublicKey(opts.mint);
          pools = await client.getPoolsByMint(mint);
        } else {
          pools = await client.getAllPools();
        }

        spinner.stop(true);

        if (pools.length === 0) {
          printInfo("No shield pools found.");
          return;
        }

        printHeader(`Shield Pools (${pools.length})`);

        const headers = [
          "Pool ID",
          "Mint",
          "Deposits",
          "Leaves",
          "Status",
        ];
        const rows = pools.map((p) => {
          const capacity = 2 ** p.treeDepth;
          return [
            shortenPubkey(p.poolId, 6),
            shortenPubkey(p.mint, 4),
            formatAmount(p.totalDeposits),
            `${p.nextLeafIndex}/${capacity}`,
            p.isPaused ? chalk.red("PAUSED") : chalk.green("ACTIVE"),
          ];
        });

        printTable(headers, rows, [16, 12, 16, 16, 8]);
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // kirite pool check-note <note>
  poolCmd
    .command("check-note")
    .description("Check if a deposit note has been withdrawn")
    .requiredOption("--note <note>", "Deposit note (base64 or file path)")
    .action(async (opts) => {
      try {
        const config = loadConfig();
        const client = new KiriteClient({
          endpoint: config.endpoint,
          commitment: config.commitment,
        });

        await client.connect();

        // Load note
        let noteString: string;
        try {
          const fs = require("fs");
          if (fs.existsSync(opts.note)) {
            noteString = fs.readFileSync(opts.note, "utf-8").trim();
          } else {
            noteString = opts.note;
          }
        } catch {
          noteString = opts.note;
        }

        const note = client.deserializeNote(noteString);

        printHeader("Deposit Note Status");
        printField("Pool", note.poolId);
        printField("Amount", formatAmount(note.amount));
        printField("Leaf Index", note.leafIndex.toString());
        printField("Commitment", formatHex(note.commitment));
        printField(
          "Deposited",
          new Date(note.timestamp * 1000).toISOString()
        );
        console.log();

        const spinner = spinnerMessage("Checking nullifier...");
        spinner.start();

        const isSpent = await client.isNoteSpent(note);
        spinner.stop(true);

        if (isSpent) {
          printField(
            "Status",
            chalk.red("WITHDRAWN (nullifier spent)")
          );
        } else {
          printField(
            "Status",
            chalk.green("AVAILABLE (can be withdrawn)")
          );
        }
        console.log();
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // kirite pool denominations <address>
  poolCmd
    .command("denominations <address>")
    .description("Show supported denominations for a pool")
    .action(async (address: string) => {
      try {
        const config = loadConfig();
        const client = new KiriteClient({
          endpoint: config.endpoint,
          commitment: config.commitment,
        });

        await client.connect();

        const poolId = new PublicKey(address);
        const poolState = await client.getPoolState(poolId);

        printHeader("Supported Denominations");

        if (poolState.denominations.length === 0) {
          printInfo("This pool accepts any amount.");
        } else {
          for (let i = 0; i < poolState.denominations.length; i++) {
            printField(
              `Tier ${i + 1}`,
              formatAmount(poolState.denominations[i])
            );
          }
        }
        console.log();
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
// pool cmd rev #23
// pool list branch
