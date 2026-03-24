#!/usr/bin/env node

import { Command } from "commander";
import { registerTransferCommand } from "./commands/transfer";
import { registerDepositCommand } from "./commands/deposit";
import { registerWithdrawCommand } from "./commands/withdraw";
import { registerStealthCommand } from "./commands/stealth";
import { registerPoolCommand } from "./commands/pool";
import { registerConfigCommand } from "./commands/config";
import { printBanner, printError } from "./utils/display";

const VERSION = "0.1.0";

function main(): void {
  const program = new Command();

  program
    .name("kirite")
    .description("KIRITE — Privacy Protocol CLI for Solana")
    .version(VERSION, "-v, --version", "Display the CLI version")
    .option("--endpoint <url>", "Solana RPC endpoint URL")
    .option("--wallet <path>", "Path to wallet keypair file")
    .option(
      "--commitment <level>",
      "Transaction commitment level (processed, confirmed, finalized)"
    );

  // Register all command groups
  registerTransferCommand(program);
  registerDepositCommand(program);
  registerWithdrawCommand(program);
  registerStealthCommand(program);
  registerPoolCommand(program);
  registerConfigCommand(program);

  // Handle unknown commands
  program.on("command:*", (operands: string[]) => {
    printError(`Unknown command: ${operands[0]}`);
    console.log();
    program.outputHelp();
    process.exit(1);
  });

  // Show help if no arguments
  if (process.argv.length <= 2) {
    printBanner();
    program.outputHelp();
    process.exit(0);
  }

  program.parseAsync(process.argv).catch((err) => {
    printError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

main();
// cli rev #20
