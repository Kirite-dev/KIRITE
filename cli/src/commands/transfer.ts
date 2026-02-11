import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  KiriteClient,
  ConfidentialTransferParams,
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
  formatAmount,
  shortenPubkey,
  spinnerMessage,
} from "../utils/display";

/**
 * Registers the `kirite transfer` command.
 */
export function registerTransferCommand(program: Command): void {
  program
    .command("transfer")
    .description("Execute a confidential transfer with encrypted amounts")
    .requiredOption("--amount <amount>", "Transfer amount (in base units)")
    .requiredOption("--to <address>", "Recipient public key (base58)")
    .requiredOption("--mint <address>", "Token mint address (base58)")
    .option(
      "--recipient-key <hex>",
      "Recipient ElGamal public key (hex). If omitted, looks up from registry."
    )
    .option("--memo <text>", "Optional memo to attach")
    .option("--wallet <path>", "Path to wallet keypair file")
    .option("--skip-preflight", "Skip transaction preflight simulation")
    .action(async (opts) => {
      printBanner();

      try {
        const config = loadConfig();
        const wallet = loadWallet(opts.wallet);

        const client = new KiriteClient({
          endpoint: config.endpoint,
          commitment: config.commitment,
          wallet,
          skipPreflight: opts.skipPreflight || config.skipPreflight,
          maxRetries: config.maxRetries,
          confirmTimeout: config.confirmTimeout * 1000,
        });

        const recipient = new PublicKey(opts.to);
        const mint = new PublicKey(opts.mint);
        const amount = new BN(opts.amount);

        printHeader("Confidential Transfer");
        printField("From", shortenPubkey(wallet.publicKey));
        printField("To", shortenPubkey(recipient));
        printField("Amount", formatAmount(amount));
        printField("Mint", shortenPubkey(mint));
        if (opts.memo) {
          printField("Memo", opts.memo);
        }
        console.log();

        // Resolve recipient's ElGamal public key
        let recipientElGamalPubkey: Uint8Array;

        if (opts.recipientKey) {
          recipientElGamalPubkey = Buffer.from(opts.recipientKey, "hex");
          printInfo("Using provided recipient ElGamal key");
        } else {
          const spinner = spinnerMessage("Looking up recipient's encryption key...");
          spinner.start();
          try {
            await client.connect();
            const registryEntry = await client.getRegistryEntry(recipient);
            recipientElGamalPubkey = registryEntry.metaAddress.viewingKey;
            spinner.stop(true);
          } catch {
            spinner.stop(false);
            printError(
              "Recipient not found in stealth registry. Provide --recipient-key manually."
            );
            process.exit(1);
            return;
          }
        }

        const params: ConfidentialTransferParams = {
          recipient,
          amount,
          mint,
          recipientElGamalPubkey,
          memo: opts.memo,
        };

        const spinner = spinnerMessage("Encrypting and sending transfer...");
        spinner.start();

        const result = await client.confidentialTransfer(params);

        spinner.stop(true);

        printTransactionResult(result.signature, "Confidential Transfer", {
          "Slot": result.slot.toString(),
          "Encrypted": "Yes (ElGamal)",
          "Proof": "Range + Equality + Balance",
        });
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // Sub-command: kirite transfer balance
  program
    .command("balance")
    .description("Show the decrypted confidential balance")
    .requiredOption("--mint <address>", "Token mint address")
    .option("--wallet <path>", "Path to wallet keypair file")
    .action(async (opts) => {
      try {
        const config = loadConfig();
        const wallet = loadWallet(opts.wallet);
        const mint = new PublicKey(opts.mint);

        const client = new KiriteClient({
          endpoint: config.endpoint,
          commitment: config.commitment,
          wallet,
        });

        await client.connect();

        const spinner = spinnerMessage("Decrypting balance...");
        spinner.start();

        const balance = await client.getConfidentialBalance(mint);

        spinner.stop(true);

        printHeader("Confidential Balance");
        printField("Wallet", wallet.publicKey.toBase58());
        printField("Mint", mint.toBase58());
        printField("Balance", formatAmount(balance));
        console.log();
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // Sub-command: kirite transfer history
  program
    .command("history")
    .description("Show decrypted incoming transfer history")
    .requiredOption("--mint <address>", "Token mint address")
    .option("--from-slot <slot>", "Start scanning from this slot")
    .option("--wallet <path>", "Path to wallet keypair file")
    .action(async (opts) => {
      try {
        const config = loadConfig();
        const wallet = loadWallet(opts.wallet);
        const mint = new PublicKey(opts.mint);

        const client = new KiriteClient({
          endpoint: config.endpoint,
          commitment: config.commitment,
          wallet,
        });

        await client.connect();

        const spinner = spinnerMessage("Scanning and decrypting transfers...");
        spinner.start();

        const fromSlot = opts.fromSlot ? parseInt(opts.fromSlot, 10) : undefined;
        const transfers = await client.decryptTransfers(mint, fromSlot);

        spinner.stop(true);

        if (transfers.length === 0) {
          printInfo("No incoming transfers found");
          return;
        }

        printHeader(`Incoming Transfers (${transfers.length})`);

        for (const tx of transfers) {
          printField("From", shortenPubkey(tx.sender));
          printField("Amount", formatAmount(tx.amount));
          printField("Slot", tx.slot.toString());
          printField(
            "Time",
            tx.timestamp
              ? new Date(tx.timestamp * 1000).toISOString()
              : "N/A"
          );
          console.log();
        }
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
