import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  StealthMetaAddress,
  StealthRegistryEntry,
  TransactionOptions,
} from "../types";
import { RegistryNotFoundError, StealthAddressError } from "../errors";
import {
  KIRITE_PROGRAM_ID,
  SEEDS,
  DISCRIMINATOR_SIZE,
  COMPUTE_BUDGET,
} from "../constants";
import {
  fetchAccountOrThrow,
  fetchProgramAccounts,
} from "../utils/connection";
import {
  buildTransaction,
  sendAndConfirmTransaction,
} from "../utils/transaction";

/**
 * Derives the stealth registry PDA for an owner.
 * @param owner - Registry owner
 * @param programId - Program ID
 * @returns PDA and bump
 */
export function deriveRegistryAddress(
  owner: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.STEALTH_REGISTRY, owner.toBuffer()],
    programId
  );
}

/**
 * Derives the stealth announcement PDA.
 * @param ephemeralPubkey - Ephemeral public key
 * @param stealthAddress - Stealth address
 * @param programId - Program ID
 * @returns PDA and bump
 */
export function deriveAnnouncementAddress(
  ephemeralPubkey: Uint8Array,
  stealthAddress: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      SEEDS.STEALTH_ANNOUNCEMENT,
      Buffer.from(ephemeralPubkey),
      stealthAddress.toBuffer(),
    ],
    programId
  );
}

/**
 * Parses a stealth registry account.
 *
 * Account layout:
 * [0..8]    - Discriminator
 * [8..40]   - Owner pubkey
 * [40..72]  - Spending key
 * [72..104] - Viewing key
 * [104..108] - Label length (u32 LE)
 * [108..108+len] - Label string (UTF-8)
 * [next..next+8]  - Created at timestamp (i64 LE)
 *
 * @param data - Raw account data
 * @returns Parsed registry entry
 */
export function parseRegistryEntry(data: Buffer): StealthRegistryEntry {
  let offset = DISCRIMINATOR_SIZE;

  const owner = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const spendingKey = new Uint8Array(data.slice(offset, offset + 32));
  offset += 32;

  const viewingKey = new Uint8Array(data.slice(offset, offset + 32));
  offset += 32;

  const labelLen = data.readUInt32LE(offset);
  offset += 4;

  const label = data.slice(offset, offset + labelLen).toString("utf-8");
  offset += labelLen;

  const createdAtLow = data.readUInt32LE(offset);
  const createdAtHigh = data.readInt32LE(offset + 4);
  const createdAt = createdAtLow + createdAtHigh * 0x100000000;

  return {
    owner,
    metaAddress: { spendingKey, viewingKey },
    label,
    createdAt,
  };
}

/**
 * Fetches a stealth registry entry for an owner.
 *
 * @param connection - Solana connection
 * @param owner - Owner public key
 * @param programId - KIRITE program ID
 * @returns Registry entry
 * @throws RegistryNotFoundError if not found
 */
export async function fetchRegistryEntry(
  connection: Connection,
  owner: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<StealthRegistryEntry> {
  const [registryAddr] = deriveRegistryAddress(owner, programId);

  try {
    const account = await fetchAccountOrThrow(
      connection,
      registryAddr,
      "StealthRegistry"
    );
    return parseRegistryEntry(account.data);
  } catch (err) {
    throw new RegistryNotFoundError(owner.toBase58());
  }
}

/**
 * Fetches all stealth registry entries.
 *
 * @param connection - Solana connection
 * @param programId - KIRITE program ID
 * @returns Array of registry entries
 */
export async function fetchAllRegistryEntries(
  connection: Connection,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<StealthRegistryEntry[]> {
  const accounts = await fetchProgramAccounts(connection, programId, [
    {
      memcmp: {
        offset: 0,
        bytes: "4Rr", // Registry account discriminator prefix
      },
    },
  ]);

  const entries: StealthRegistryEntry[] = [];

  for (const { account } of accounts) {
    try {
      entries.push(parseRegistryEntry(account.data));
    } catch {
      continue;
    }
  }

  return entries;
}

/**
 * Looks up a recipient's stealth meta-address from the on-chain registry.
 *
 * @param connection - Solana connection
 * @param recipient - Recipient's public key
 * @param programId - KIRITE program ID
 * @returns Stealth meta-address
 * @throws RegistryNotFoundError if not registered
 */
export async function lookupStealthMetaAddress(
  connection: Connection,
  recipient: PublicKey,
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<StealthMetaAddress> {
  const entry = await fetchRegistryEntry(connection, recipient, programId);
  return entry.metaAddress;
}

/**
 * Builds the instruction to register a stealth meta-address.
 *
 * @param owner - Owner public key
 * @param metaAddress - Stealth meta-address to register
 * @param label - Human-readable label (max 64 bytes)
 * @param programId - KIRITE program ID
 * @returns Transaction instruction
 */
export function buildRegisterInstruction(
  owner: PublicKey,
  metaAddress: StealthMetaAddress,
  label: string = "",
  programId: PublicKey = KIRITE_PROGRAM_ID
): TransactionInstruction {
  const [registryAddr] = deriveRegistryAddress(owner, programId);

  // Instruction discriminator: sha256("global:register_stealth")[0..8]
  const discriminator = Buffer.from([0x5c, 0x6d, 0x7e, 0x8f, 0x9a, 0xab, 0xbc, 0xcd]);

  const labelBytes = Buffer.from(label, "utf-8").slice(0, 64);
  const labelLenBuf = Buffer.alloc(4);
  labelLenBuf.writeUInt32LE(labelBytes.length, 0);

  const data = Buffer.concat([
    discriminator,
    Buffer.from(metaAddress.spendingKey),  // 32 bytes
    Buffer.from(metaAddress.viewingKey),    // 32 bytes
    labelLenBuf,                           // 4 bytes
    labelBytes,                            // variable
  ]);

  return new TransactionInstruction({
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: registryAddr, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

/**
 * Builds the instruction to update a stealth meta-address.
 *
 * @param owner - Owner public key
 * @param newMetaAddress - New stealth meta-address
 * @param newLabel - New label (optional)
 * @param programId - KIRITE program ID
 * @returns Transaction instruction
 */
export function buildUpdateRegistryInstruction(
  owner: PublicKey,
  newMetaAddress: StealthMetaAddress,
  newLabel?: string,
  programId: PublicKey = KIRITE_PROGRAM_ID
): TransactionInstruction {
  const [registryAddr] = deriveRegistryAddress(owner, programId);

  // Instruction discriminator: sha256("global:update_stealth_registry")[0..8]
  const discriminator = Buffer.from([0x6e, 0x7f, 0x8a, 0x9b, 0xac, 0xbd, 0xce, 0xdf]);

  const labelBytes = newLabel
    ? Buffer.from(newLabel, "utf-8").slice(0, 64)
    : Buffer.alloc(0);
  const labelLenBuf = Buffer.alloc(4);
  labelLenBuf.writeUInt32LE(labelBytes.length, 0);

  const data = Buffer.concat([
    discriminator,
    Buffer.from(newMetaAddress.spendingKey),
    Buffer.from(newMetaAddress.viewingKey),
    labelLenBuf,
    labelBytes,
  ]);

  return new TransactionInstruction({
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: registryAddr, isSigner: false, isWritable: true },
    ],
    programId,
    data,
  });
}

/**
 * Builds the instruction to emit a stealth announcement.
 * This is called by the sender after sending funds to a stealth address.
 *
 * @param sender - Sender's public key
 * @param ephemeralPubkey - Ephemeral public key
 * @param stealthAddress - Stealth address that received funds
 * @param viewTag - View tag for efficient scanning
 * @param programId - KIRITE program ID
 * @returns Transaction instruction
 */
export function buildAnnouncementInstruction(
  sender: PublicKey,
  ephemeralPubkey: Uint8Array,
  stealthAddress: PublicKey,
  viewTag: number,
  programId: PublicKey = KIRITE_PROGRAM_ID
): TransactionInstruction {
  const [announcementAddr] = deriveAnnouncementAddress(
    ephemeralPubkey,
    stealthAddress,
    programId
  );

  // Instruction discriminator: sha256("global:stealth_announce")[0..8]
  const discriminator = Buffer.from([0x7a, 0x8b, 0x9c, 0xad, 0xbe, 0xcf, 0xd0, 0xe1]);

  const data = Buffer.concat([
    discriminator,
    Buffer.from(ephemeralPubkey),           // 32 bytes
    stealthAddress.toBuffer(),              // 32 bytes
    Buffer.from([viewTag]),                 // 1 byte
  ]);

  return new TransactionInstruction({
    keys: [
      { pubkey: sender, isSigner: true, isWritable: true },
      { pubkey: announcementAddr, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

/**
 * Registers a stealth meta-address on-chain.
 *
 * @param connection - Solana connection
 * @param wallet - Owner's keypair
 * @param metaAddress - Stealth meta-address to register
 * @param label - Optional label
 * @param options - Transaction options
 * @param programId - KIRITE program ID
 * @returns Transaction signature
 */
export async function registerStealthMetaAddress(
  connection: Connection,
  wallet: Keypair,
  metaAddress: StealthMetaAddress,
  label: string = "",
  options: TransactionOptions = {},
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<string> {
  const registerIx = buildRegisterInstruction(
    wallet.publicKey,
    metaAddress,
    label,
    programId
  );

  const tx = await buildTransaction(
    connection,
    wallet.publicKey,
    [registerIx],
    COMPUTE_BUDGET.REGISTRY_UPDATE
  );

  return sendAndConfirmTransaction(connection, tx, [wallet], options);
}

/**
 * Publishes a stealth announcement after sending to a stealth address.
 *
 * @param connection - Solana connection
 * @param wallet - Sender's keypair
 * @param ephemeralPubkey - Ephemeral public key
 * @param stealthAddress - Stealth address
 * @param viewTag - View tag
 * @param options - Transaction options
 * @param programId - KIRITE program ID
 * @returns Transaction signature
 */
export async function publishStealthAnnouncement(
  connection: Connection,
  wallet: Keypair,
  ephemeralPubkey: Uint8Array,
  stealthAddress: PublicKey,
  viewTag: number,
  options: TransactionOptions = {},
  programId: PublicKey = KIRITE_PROGRAM_ID
): Promise<string> {
  const announceIx = buildAnnouncementInstruction(
    wallet.publicKey,
    ephemeralPubkey,
    stealthAddress,
    viewTag,
    programId
  );

  const tx = await buildTransaction(
    connection,
    wallet.publicKey,
    [announceIx],
    COMPUTE_BUDGET.STEALTH_SEND
  );

  return sendAndConfirmTransaction(connection, tx, [wallet], options);
}
// reg rev #16
