import * as fs from "fs";
import * as path from "path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { loadConfig } from "./config";

/**
 * Loads the wallet keypair from the configured path.
 * Supports both JSON array format and base58 private keys.
 *
 * @param walletPathOverride - Optional path override
 * @returns Solana Keypair
 * @throws Error if the wallet file cannot be loaded
 */
export function loadWallet(walletPathOverride?: string): Keypair {
  const config = loadConfig();
  const walletPath = walletPathOverride || config.walletPath;

  const resolved = resolvePath(walletPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Wallet file not found: ${resolved}\n` +
        `Set your wallet path with: kirite config set wallet <path>\n` +
        `Or generate a new keypair with: solana-keygen new`
    );
  }

  const content = fs.readFileSync(resolved, "utf-8").trim();

  // Try JSON array format first (Solana CLI standard)
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      if (parsed.length === 64) {
        return Keypair.fromSecretKey(Uint8Array.from(parsed));
      }
      throw new Error(
        `Invalid keypair array length: expected 64, got ${parsed.length}`
      );
    }
  } catch (jsonErr) {
    // Not JSON, try other formats
  }

  // Try base58 encoded secret key
  try {
    const bs58 = require("bs58");
    const decoded = bs58.decode(content);
    if (decoded.length === 64) {
      return Keypair.fromSecretKey(decoded);
    }
  } catch {
    // Not base58
  }

  // Try raw hex
  try {
    if (/^[0-9a-fA-F]{128}$/.test(content)) {
      const bytes = Buffer.from(content, "hex");
      if (bytes.length === 64) {
        return Keypair.fromSecretKey(bytes);
      }
    }
  } catch {
    // Not hex
  }

  throw new Error(
    `Could not parse wallet file: ${resolved}\n` +
      `Supported formats: JSON array [u8;64], base58, hex`
  );
}

/**
 * Gets the wallet public key without loading the full secret key.
 * Reads and parses just enough to derive the public key.
 *
 * @param walletPathOverride - Optional path override
 * @returns Public key
 */
export function getWalletPublicKey(walletPathOverride?: string): PublicKey {
  const keypair = loadWallet(walletPathOverride);
  return keypair.publicKey;
}

/**
 * Checks if a wallet file exists at the configured or given path.
 *
 * @param walletPathOverride - Optional path override
 * @returns True if the wallet file exists
 */
export function walletExists(walletPathOverride?: string): boolean {
  const config = loadConfig();
  const walletPath = walletPathOverride || config.walletPath;
  return fs.existsSync(resolvePath(walletPath));
}

/**
 * Generates a new keypair and saves it to a file.
 *
 * @param outputPath - Path to save the keypair
 * @returns Generated keypair
 */
export function generateAndSaveKeypair(outputPath: string): Keypair {
  const keypair = Keypair.generate();
  const resolved = resolvePath(outputPath);

  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const json = JSON.stringify(Array.from(keypair.secretKey));
  fs.writeFileSync(resolved, json, "utf-8");

  return keypair;
}

/**
 * Resolves a file path, expanding ~ to home directory.
 */
function resolvePath(filePath: string): string {
  if (filePath.startsWith("~")) {
    const os = require("os");
    return path.join(os.homedir(), filePath.slice(1));
  }
  return path.resolve(filePath);
}

/**
 * Displays wallet info (public key, balance status).
 *
 * @param walletPathOverride - Optional path override
 * @returns Object with wallet info
 */
export function getWalletInfo(walletPathOverride?: string): {
  publicKey: string;
  path: string;
  exists: boolean;
} {
  const config = loadConfig();
  const walletPath = walletPathOverride || config.walletPath;
  const resolved = resolvePath(walletPath);

  if (!fs.existsSync(resolved)) {
    return {
      publicKey: "N/A",
      path: resolved,
      exists: false,
    };
  }

  try {
    const keypair = loadWallet(walletPathOverride);
    return {
      publicKey: keypair.publicKey.toBase58(),
      path: resolved,
      exists: true,
    };
  } catch {
    return {
      publicKey: "Error loading",
      path: resolved,
      exists: true,
    };
  }
}
// wallet rev #24
