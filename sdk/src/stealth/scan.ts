import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  StealthPayment,
  StealthMetaAddress,
  StealthAnnouncementEvent,
  ScanStealthParams,
} from "../types";
import { KIRITE_PROGRAM_ID, SEEDS, DISCRIMINATOR_SIZE } from "../constants";
import { checkViewTag, deriveStealthSpendingKey } from "./address";
import { fetchProgramAccounts, getRecentSignatures } from "../utils/connection";
import { hash256 } from "../utils/keypair";

/**
 * Scans the blockchain for incoming stealth payments.
 *
 * The scanning process:
 * 1. Fetch stealth announcement events from the on-chain program
 * 2. For each announcement, check the view tag (fast filter)
 * 3. If the view tag matches, compute the full ECDH to verify
 * 4. Derive the stealth spending key for matching announcements
 *
 * @param connection - Solana connection
 * @param params - Scanning parameters (viewing key, spending key, slot range)
 * @param programId - KIRITE program ID
 * @returns Array of stealth payments addressed to us
 */
export async function scanStealthPayments(
  connection: Connection,
  params: ScanStealthParams,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<StealthPayment[]> {
  const payments: StealthPayment[] = [];

  // Fetch stealth announcement accounts
  const announcements = await fetchStealthAnnouncements(
    connection,
    params.fromSlot,
    params.toSlot,
    programId
  );

  for (const announcement of announcements) {
    // Step 1: Fast view tag check
    const viewTagMatch = checkViewTag(
      announcement.ephemeralPubkey,
      announcement.viewTag,
      params.viewingKey
    );

    if (!viewTagMatch) {
      continue; // Not for us, skip
    }

    // Step 2: Full verification — derive the stealth address
    const stealthKeypair = deriveStealthSpendingKey(
      announcement.ephemeralPubkey,
      params.viewingKey,
      params.spendingKey
    );

    // Step 3: Check if the derived address matches the announcement
    if (stealthKeypair.publicKey.equals(announcement.stealthAddress)) {
      // This payment is for us
      // Fetch the balance at the stealth address
      const balance = await getStealthAddressBalance(
        connection,
        announcement.stealthAddress
      );

      payments.push({
        address: announcement.stealthAddress,
        ephemeralPubkey: announcement.ephemeralPubkey,
        amount: balance.amount,
        mint: balance.mint,
        timestamp: announcement.timestamp,
        slot: announcement.slot,
        txSignature: announcement.signature,
      });
    }
  }

  return payments;
}

/**
 * Fetches stealth announcement events from the chain.
 *
 * @param connection - Solana connection
 * @param fromSlot - Start slot (optional)
 * @param toSlot - End slot (optional)
 * @param programId - KIRITE program ID
 * @returns Array of parsed announcements
 */
async function fetchStealthAnnouncements(
  connection: Connection,
  fromSlot?: number,
  toSlot?: number,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<StealthAnnouncementEvent[]> {
  // Fetch announcement accounts from the program
  const accounts = await fetchProgramAccounts(connection, programId, [
    {
      memcmp: {
        offset: 0,
        // Stealth announcement discriminator
        bytes: "3Qq", // Base58 prefix for announcement accounts
      },
    },
  ]);

  const announcements: StealthAnnouncementEvent[] = [];

  for (const { pubkey, account } of accounts) {
    try {
      const parsed = parseAnnouncementAccount(account.data, pubkey);

      // Filter by slot range
      if (fromSlot && parsed.slot < fromSlot) continue;
      if (toSlot && parsed.slot > toSlot) continue;

      announcements.push(parsed);
    } catch {
      continue;
    }
  }

  // Sort by slot ascending
  announcements.sort((a, b) => a.slot - b.slot);

  return announcements;
}

/**
 * Parses a stealth announcement account's data.
 *
 * Account layout:
 * [0..8]   - Discriminator
 * [8..40]  - Ephemeral public key
 * [40..72] - Stealth address
 * [72]     - View tag
 * [73..81] - Slot (u64 LE)
 * [81..89] - Timestamp (i64 LE)
 * [89..153] - Transaction signature (64 bytes)
 *
 * @param data - Raw account data
 * @param pubkey - Account address
 * @returns Parsed announcement event
 */
function parseAnnouncementAccount(
  data: Buffer,
  pubkey: PublicKey
): StealthAnnouncementEvent {
  let offset = DISCRIMINATOR_SIZE;

  const ephemeralPubkey = new Uint8Array(data.slice(offset, offset + 32));
  offset += 32;

  const stealthAddress = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const viewTag = data.readUInt8(offset);
  offset += 1;

  const slotLow = data.readUInt32LE(offset);
  const slotHigh = data.readUInt32LE(offset + 4);
  const slot = slotLow + slotHigh * 0x100000000;
  offset += 8;

  const timestampLow = data.readUInt32LE(offset);
  const timestampHigh = data.readInt32LE(offset + 4);
  const timestamp = timestampLow + timestampHigh * 0x100000000;
  offset += 8;

  const signatureBytes = data.slice(offset, offset + 64);
  const signature = Buffer.from(signatureBytes).toString("base64");

  return {
    ephemeralPubkey,
    stealthAddress,
    viewTag,
    slot,
    timestamp,
    signature,
  };
}

/**
 * Gets the token balance at a stealth address.
 * Checks both SOL and SPL token balances.
 *
 * @param connection - Solana connection
 * @param address - Stealth address
 * @returns Balance info
 */
async function getStealthAddressBalance(
  connection: Connection,
  address: PublicKey
): Promise<{ amount: BN; mint: PublicKey }> {
  // Check SOL balance first
  const solBalance = await connection.getBalance(address);

  if (solBalance > 0) {
    return {
      amount: new BN(solBalance),
      mint: PublicKey.default, // Native SOL
    };
  }

  // Check for SPL token accounts owned by this address
  const tokenAccounts = await connection.getTokenAccountsByOwner(address, {
    programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  });

  if (tokenAccounts.value.length > 0) {
    // Parse the first token account with a balance
    for (const { account } of tokenAccounts.value) {
      const data = account.data;
      // SPL Token account layout: mint (32) + owner (32) + amount (8)
      const mint = new PublicKey(data.slice(0, 32));
      const amountBytes = data.slice(64, 72);
      const amount = new BN(amountBytes, "le");

      if (!amount.isZero()) {
        return { amount, mint };
      }
    }
  }

  return {
    amount: new BN(0),
    mint: PublicKey.default,
  };
}

/**
 * Scans for stealth payments using transaction log parsing.
 * This is an alternative scanning method that uses transaction logs
 * instead of account queries, useful when announcement accounts
 * may have been cleaned up.
 *
 * @param connection - Solana connection
 * @param viewingKey - Viewing secret key
 * @param spendingKey - Spending secret key
 * @param referencePubkey - A reference pubkey to query signatures from
 * @param limit - Maximum number of transactions to scan
 * @param programId - KIRITE program ID
 * @returns Array of detected stealth payments
 */
export async function scanStealthPaymentsFromLogs(
  connection: Connection,
  viewingKey: Uint8Array,
  spendingKey: Uint8Array,
  referencePubkey: PublicKey,
  limit: number = 500,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<StealthPayment[]> {
  const payments: StealthPayment[] = [];

  // Fetch recent signatures
  const signatures = await getRecentSignatures(
    connection,
    referencePubkey,
    limit
  );

  for (const sigInfo of signatures) {
    try {
      const tx = await connection.getTransaction(sigInfo.signature, {
        commitment: "confirmed",
      });

      if (!tx || !tx.meta || !tx.meta.logMessages) continue;

      // Look for stealth announcement log entries
      for (const log of tx.meta.logMessages) {
        const match = log.match(
          /Program log: StealthAnnouncement\{ephemeral:([a-f0-9]+),address:([a-zA-Z0-9]+),tag:(\d+)\}/
        );

        if (!match) continue;

        const ephemeralPubkey = Buffer.from(match[1], "hex");
        const stealthAddress = new PublicKey(match[2]);
        const viewTag = parseInt(match[3], 10);

        // Check view tag
        if (!checkViewTag(ephemeralPubkey, viewTag, viewingKey)) {
          continue;
        }

        // Full verification
        const stealthKeypair = deriveStealthSpendingKey(
          ephemeralPubkey,
          viewingKey,
          spendingKey
        );

        if (stealthKeypair.publicKey.equals(stealthAddress)) {
          const balance = await getStealthAddressBalance(
            connection,
            stealthAddress
          );

          payments.push({
            address: stealthAddress,
            ephemeralPubkey,
            amount: balance.amount,
            mint: balance.mint,
            timestamp: tx.blockTime || 0,
            slot: sigInfo.slot,
            txSignature: sigInfo.signature,
          });
        }
      }
    } catch {
      continue;
    }
  }

  return payments;
}

/**
 * Calculates the total unclaimed balance across all stealth payments.
 *
 * @param payments - Array of stealth payments
 * @returns Map of mint address to total balance
 */
export function calculateStealthBalances(
  payments: StealthPayment[]
): Map<string, BN> {
  const balances = new Map<string, BN>();

  for (const payment of payments) {
    const mintKey = payment.mint.toBase58();
    const current = balances.get(mintKey) || new BN(0);
    balances.set(mintKey, current.add(payment.amount));
  }

  return balances;
}
// scan rev #17
