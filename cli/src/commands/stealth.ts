import { Command } from "commander";
import { PublicKey, Keypair } from "@solana/web3.js";
import BN from "bn.js";
import {
  KiriteClient,
  serializeStealthMetaAddress,
  deserializeStealthMetaAddress,
  validateStealthMetaAddress,
  StealthMetaAddress,
} from "@kirite/sdk";
import { loadConfig } from "../utils/config";
import { loadWallet } from "../utils/wallet";
import {
  printBanner,
  printHeader,
  printField,
  printSuccess,
  printError,
  printWarning,
  printInfo,
  printTransactionResult,
  printTable,
  formatAmount,
  shortenPubkey,
  formatHex,
  formatTimestamp,
  spinnerMessage,
} from "../utils/display";

/**
 * Registers the `kirite stealth` command group.
 */
export function registerStealthCommand(program: Command): void {
  const stealthCmd = program
    .command("stealth")
    .description("Stealth address operations");

  // kirite stealth generate
  stealthCmd
    .command("generate")
    .description("Generate your stealth meta-address")
    .option("--wallet <path>", "Path to wallet keypair file")
    .option("--register", "Register the meta-address on-chain")
    .option("--label <label>", "Label for registry entry")
    .action(async (opts) => {
      printBanner();

      try {
        const config = loadConfig();
        const wallet = loadWallet(opts.wallet);

        const client = new KiriteClient({
          endpoint: config.endpoint,
          commitment: config.commitment,
          wallet,
        });

        const metaAddress = client.generateStealthMetaAddress();
        const serialized = serializeStealthMetaAddress(metaAddress);

        printHeader("Stealth Meta-Address");
        printField("Owner", wallet.publicKey.toBase58());
        printField("Spending Key", formatHex(metaAddress.spendingKey));
        printField("Viewing Key", formatHex(metaAddress.viewingKey));
        console.log();
        printInfo("Full Meta-Address (share this for receiving):");
        console.log(`  ${serialized}`);
        console.log();

        if (opts.register) {
          await client.connect();

          const spinner = spinnerMessage("Registering meta-address on-chain...");
          spinner.start();

          const sig = await client.registerStealth(opts.label || "");
          spinner.stop(true);

          printTransactionResult(sig, "Stealth Registry Registration", {
            "Label": opts.label || "(none)",
          });
        }
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // kirite stealth send
  stealthCmd
    .command("send")
    .description("Generate a stealth address for a recipient and display it")
    .requiredOption(
      "--to <meta-address>",
      "Recipient's stealth meta-address (hex) or public key (base58)"
    )
    .option("--wallet <path>", "Path to wallet keypair file")
    .action(async (opts) => {
      printBanner();

      try {
        const config = loadConfig();
        const wallet = loadWallet(opts.wallet);

        const client = new KiriteClient({
          endpoint: config.endpoint,
          commitment: config.commitment,
          wallet,
        });

        let metaAddress: StealthMetaAddress;

        // Check if input is a hex meta-address or a base58 public key
        if (opts.to.length === 128 && /^[0-9a-f]+$/i.test(opts.to)) {
          metaAddress = deserializeStealthMetaAddress(opts.to);
        } else {
          // Try as public key — look up from registry
          await client.connect();
          const recipientKey = new PublicKey(opts.to);

          const spinner = spinnerMessage(
            "Looking up recipient in stealth registry..."
          );
          spinner.start();

          try {
            metaAddress = await client.lookupStealthAddress(recipientKey);
            spinner.stop(true);
          } catch {
            spinner.stop(false);
            printError(
              "Recipient not found in registry. Provide their meta-address directly."
            );
            process.exit(1);
            return;
          }
        }

        if (!validateStealthMetaAddress(metaAddress)) {
          printError("Invalid stealth meta-address");
          process.exit(1);
        }

        const stealth = client.generateStealthAddress(metaAddress);

        printHeader("Generated Stealth Address");
        printField("Stealth Address", stealth.address.toBase58());
        printField("Ephemeral Key", formatHex(stealth.ephemeralPubkey));
        printField("View Tag", stealth.viewTag.toString());
        console.log();

        printInfo("Send funds to the stealth address above.");
        printInfo(
          "After sending, publish the announcement so the recipient can find it:"
        );
        console.log();
        console.log(
          `  kirite stealth announce \\`
        );
        console.log(
          `    --ephemeral ${Buffer.from(stealth.ephemeralPubkey).toString("hex")} \\`
        );
        console.log(
          `    --address ${stealth.address.toBase58()} \\`
        );
        console.log(`    --tag ${stealth.viewTag}`);
        console.log();
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // kirite stealth announce
  stealthCmd
    .command("announce")
    .description("Publish a stealth payment announcement on-chain")
    .requiredOption("--ephemeral <hex>", "Ephemeral public key (hex)")
    .requiredOption("--address <base58>", "Stealth address (base58)")
    .requiredOption("--tag <number>", "View tag (0-255)")
    .option("--wallet <path>", "Path to wallet keypair file")
    .action(async (opts) => {
      printBanner();

      try {
        const config = loadConfig();
        const wallet = loadWallet(opts.wallet);

        const client = new KiriteClient({
          endpoint: config.endpoint,
          commitment: config.commitment,
          wallet,
          maxRetries: config.maxRetries,
          confirmTimeout: config.confirmTimeout * 1000,
        });

        await client.connect();

        const ephemeralPubkey = Buffer.from(opts.ephemeral, "hex");
        const stealthAddress = new PublicKey(opts.address);
        const viewTag = parseInt(opts.tag, 10);

        if (viewTag < 0 || viewTag > 255) {
          printError("View tag must be between 0 and 255");
          process.exit(1);
        }

        printHeader("Stealth Announcement");
        printField("Stealth Address", stealthAddress.toBase58());
        printField("View Tag", viewTag.toString());
        console.log();

        const spinner = spinnerMessage("Publishing announcement...");
        spinner.start();

        const sig = await client.announceStealthPayment(
          ephemeralPubkey,
          stealthAddress,
          viewTag
        );

        spinner.stop(true);

        printTransactionResult(sig, "Stealth Announcement Published");
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // kirite stealth scan
  stealthCmd
    .command("scan")
    .description("Scan for incoming stealth payments")
    .option("--from-slot <slot>", "Start scanning from this slot")
    .option("--to-slot <slot>", "End scanning at this slot")
    .option("--wallet <path>", "Path to wallet keypair file")
    .action(async (opts) => {
      printBanner();

      try {
        const config = loadConfig();
        const wallet = loadWallet(opts.wallet);

        const client = new KiriteClient({
          endpoint: config.endpoint,
          commitment: config.commitment,
          wallet,
        });

        await client.connect();

        const fromSlot = opts.fromSlot
          ? parseInt(opts.fromSlot, 10)
          : undefined;
        const toSlot = opts.toSlot ? parseInt(opts.toSlot, 10) : undefined;

        const spinner = spinnerMessage("Scanning for stealth payments...");
        spinner.start();

        const payments = await client.scanStealthPayments(fromSlot, toSlot);

        spinner.stop(true);

        if (payments.length === 0) {
          printInfo("No stealth payments found in the specified range.");
          return;
        }

        printHeader(`Stealth Payments Found (${payments.length})`);

        for (const payment of payments) {
          printField("Address", payment.address.toBase58());
          printField("Amount", formatAmount(payment.amount));
          printField("Mint", shortenPubkey(payment.mint));
          printField("Slot", payment.slot.toString());
          printField("Time", formatTimestamp(payment.timestamp));
          printField("Tx", shortenPubkey(payment.txSignature, 8));
          console.log();
        }

        // Show totals
        const totals = new Map<string, BN>();
        for (const p of payments) {
          const key = p.mint.toBase58();
          totals.set(key, (totals.get(key) || new BN(0)).add(p.amount));
        }

        printHeader("Total Unclaimed");
        for (const [mint, total] of totals) {
          printField(shortenPubkey(mint), formatAmount(total));
        }
        console.log();
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // kirite stealth lookup
  stealthCmd
    .command("lookup")
    .description("Look up a user's stealth meta-address from the registry")
    .requiredOption("--address <base58>", "User's public key")
    .action(async (opts) => {
      try {
        const config = loadConfig();

        const client = new KiriteClient({
          endpoint: config.endpoint,
          commitment: config.commitment,
        });

        await client.connect();

        const address = new PublicKey(opts.address);

        const spinner = spinnerMessage("Looking up registry...");
        spinner.start();

        const entry = await client.getRegistryEntry(address);
        spinner.stop(true);

        printHeader("Stealth Registry Entry");
        printField("Owner", entry.owner.toBase58());
        printField("Label", entry.label || "(none)");
        printField("Spending Key", formatHex(entry.metaAddress.spendingKey));
        printField("Viewing Key", formatHex(entry.metaAddress.viewingKey));
        printField(
          "Meta-Address",
          serializeStealthMetaAddress(entry.metaAddress)
        );
        printField("Created", formatTimestamp(entry.createdAt));
        console.log();
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
