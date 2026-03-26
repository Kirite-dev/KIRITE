import chalk from "chalk";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";

const SEPARATOR = "─".repeat(60);
const DOUBLE_SEPARATOR = "═".repeat(60);

/**
 * Prints the KIRITE banner.
 */
export function printBanner(): void {
  console.log(chalk.green(DOUBLE_SEPARATOR));
  console.log(
    chalk.green.bold("  KIRITE") +
      chalk.gray(" — Privacy Protocol for Solana")
  );
  console.log(chalk.green(DOUBLE_SEPARATOR));
  console.log();
}

/**
 * Prints a section header.
 */
export function printHeader(title: string): void {
  console.log();
  console.log(chalk.cyan.bold(`  ${title}`));
  console.log(chalk.gray(`  ${SEPARATOR}`));
}

/**
 * Prints a key-value pair.
 */
export function printField(label: string, value: string): void {
  console.log(chalk.gray(`  ${label.padEnd(20)}`), chalk.white(value));
}

/**
 * Prints a success message.
 */
export function printSuccess(message: string): void {
  console.log(chalk.green(`  [OK] ${message}`));
}

/**
 * Prints an error message.
 */
export function printError(message: string): void {
  console.error(chalk.red(`  [ERROR] ${message}`));
}

/**
 * Prints a warning message.
 */
export function printWarning(message: string): void {
  console.log(chalk.yellow(`  [WARN] ${message}`));
}

/**
 * Prints an info message.
 */
export function printInfo(message: string): void {
  console.log(chalk.blue(`  [INFO] ${message}`));
}

/**
 * Formats a BN amount with decimals.
 * @param amount - Raw amount in base units
 * @param decimals - Number of decimal places
 * @returns Formatted string
 */
export function formatAmount(amount: BN, decimals: number = 9): string {
  const str = amount.toString();
  if (str.length <= decimals) {
    const padded = str.padStart(decimals + 1, "0");
    return `${padded.slice(0, padded.length - decimals)}.${padded.slice(
      padded.length - decimals
    )}`;
  }
  const integerPart = str.slice(0, str.length - decimals);
  const decimalPart = str.slice(str.length - decimals);
  return `${integerPart}.${decimalPart}`;
}

/**
 * Shortens a public key for display.
 * @param pubkey - Public key
 * @param chars - Number of characters to show on each end
 * @returns Shortened string
 */
export function shortenPubkey(pubkey: PublicKey | string, chars: number = 4): string {
  const str = typeof pubkey === "string" ? pubkey : pubkey.toBase58();
  if (str.length <= chars * 2 + 3) return str;
  return `${str.slice(0, chars)}...${str.slice(-chars)}`;
}

/**
 * Formats a timestamp to human-readable form.
 */
export function formatTimestamp(unixTimestamp: number): string {
  if (unixTimestamp === 0) return "N/A";
  return new Date(unixTimestamp * 1000).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Formats bytes as hex with optional truncation.
 */
export function formatHex(bytes: Uint8Array, maxLength: number = 16): string {
  const hex = Buffer.from(bytes).toString("hex");
  if (hex.length <= maxLength * 2) return hex;
  return hex.slice(0, maxLength) + "..." + hex.slice(-8);
}

/**
 * Prints a transaction result.
 */
export function printTransactionResult(
  signature: string,
  description: string,
  additionalFields?: Record<string, string>
): void {
  printHeader("Transaction Result");
  printField("Status", chalk.green("Confirmed"));
  printField("Description", description);
  printField("Signature", signature);

  if (additionalFields) {
    for (const [key, value] of Object.entries(additionalFields)) {
      printField(key, value);
    }
  }

  console.log();
  printInfo(
    `Explorer: https://explorer.solana.com/tx/${signature}`
  );
  console.log();
}

/**
 * Prints a table of items.
 */
export function printTable(
  headers: string[],
  rows: string[][],
  columnWidths?: number[]
): void {
  const widths =
    columnWidths ||
    headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => (r[i] || "").length))
    );

  // Header
  const headerLine = headers
    .map((h, i) => h.padEnd(widths[i]))
    .join("  ");
  console.log(chalk.cyan.bold(`  ${headerLine}`));
  console.log(
    chalk.gray(
      `  ${widths.map((w) => "─".repeat(w)).join("  ")}`
    )
  );

  // Rows
  for (const row of rows) {
    const line = row
      .map((cell, i) => (cell || "").padEnd(widths[i]))
      .join("  ");
    console.log(`  ${line}`);
  }
  console.log();
}

/**
 * Prints pool state in a readable format.
 */
export function printPoolState(pool: {
  poolId: PublicKey;
  authority: PublicKey;
  mint: PublicKey;
  nextLeafIndex: number;
  treeDepth: number;
  totalDeposits: BN;
  totalWithdrawals: BN;
  isPaused: boolean;
  denominations: BN[];
}): void {
  printHeader("Shield Pool State");
  printField("Pool ID", pool.poolId.toBase58());
  printField("Authority", shortenPubkey(pool.authority));
  printField("Mint", pool.mint.toBase58());
  printField("Tree Depth", pool.treeDepth.toString());
  printField("Leaves Used", `${pool.nextLeafIndex} / ${2 ** pool.treeDepth}`);
  printField("Total Deposits", formatAmount(pool.totalDeposits));
  printField("Total Withdrawals", formatAmount(pool.totalWithdrawals));
  printField(
    "Status",
    pool.isPaused ? chalk.red("PAUSED") : chalk.green("ACTIVE")
  );

  if (pool.denominations.length > 0) {
    printField(
      "Denominations",
      pool.denominations.map((d) => formatAmount(d)).join(", ")
    );
  }
  console.log();
}

/**
 * Creates a simple progress spinner message.
 */
export function spinnerMessage(message: string): {
  start: () => void;
  stop: (success?: boolean) => void;
} {
  let interval: NodeJS.Timeout | null = null;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frameIndex = 0;

  return {
    start() {
      interval = setInterval(() => {
        process.stdout.write(
          `\r  ${chalk.cyan(frames[frameIndex])} ${message}`
        );
        frameIndex = (frameIndex + 1) % frames.length;
      }, 80);
    },
    stop(success = true) {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      const icon = success ? chalk.green("✓") : chalk.red("✗");
      process.stdout.write(`\r  ${icon} ${message}\n`);
    },
  };
}
// display rev #25
