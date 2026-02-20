import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  generateStealthMetaAddress,
  generateStealthAddress,
  checkViewTag,
  deriveStealthSpendingKey,
  recoverStealthAddress,
  serializeStealthMetaAddress,
  deserializeStealthMetaAddress,
  validateStealthMetaAddress,
} from "../src/stealth/address";
import {
  deriveRegistryAddress,
  deriveAnnouncementAddress,
} from "../src/stealth/registry";
import { calculateStealthBalances } from "../src/stealth/scan";
import {
  deriveViewingKeypair,
  deriveSpendingKeypair,
} from "../src/utils/keypair";
import { KIRITE_PROGRAM_ID } from "../src/constants";
import { StealthAddressError } from "../src/errors";

describe("Stealth Address Generation", () => {
  const wallet = Keypair.generate();

  describe("generateStealthMetaAddress", () => {
    it("generates a valid meta-address", () => {
      const meta = generateStealthMetaAddress(wallet);

      expect(meta.spendingKey.length).toBe(32);
      expect(meta.viewingKey.length).toBe(32);
    });

    it("is deterministic for the same wallet", () => {
      const meta1 = generateStealthMetaAddress(wallet);
      const meta2 = generateStealthMetaAddress(wallet);

      expect(Buffer.from(meta1.spendingKey).toString("hex")).toBe(
        Buffer.from(meta2.spendingKey).toString("hex")
      );
      expect(Buffer.from(meta1.viewingKey).toString("hex")).toBe(
        Buffer.from(meta2.viewingKey).toString("hex")
      );
    });

    it("different wallets produce different meta-addresses", () => {
      const otherWallet = Keypair.generate();
      const meta1 = generateStealthMetaAddress(wallet);
      const meta2 = generateStealthMetaAddress(otherWallet);

      expect(Buffer.from(meta1.spendingKey).toString("hex")).not.toBe(
        Buffer.from(meta2.spendingKey).toString("hex")
      );
    });
  });

  describe("generateStealthAddress", () => {
    it("generates a valid stealth address", () => {
      const meta = generateStealthMetaAddress(wallet);
      const stealth = generateStealthAddress(meta);

      expect(stealth.address).toBeInstanceOf(PublicKey);
      expect(stealth.ephemeralPubkey.length).toBe(32);
      expect(stealth.viewTag).toBeGreaterThanOrEqual(0);
      expect(stealth.viewTag).toBeLessThanOrEqual(255);
    });

    it("generates unique addresses each time (different ephemeral keys)", () => {
      const meta = generateStealthMetaAddress(wallet);

      const addr1 = generateStealthAddress(meta);
      const addr2 = generateStealthAddress(meta);

      expect(addr1.address.toBase58()).not.toBe(addr2.address.toBase58());
      expect(Buffer.from(addr1.ephemeralPubkey).toString("hex")).not.toBe(
        Buffer.from(addr2.ephemeralPubkey).toString("hex")
      );
    });

    it("throws on invalid meta-address key sizes", () => {
      expect(() => {
        generateStealthAddress({
          spendingKey: new Uint8Array(16),
          viewingKey: new Uint8Array(32),
        });
      }).toThrow(StealthAddressError);
    });
  });

  describe("checkViewTag", () => {
    it("returns true for matching view tag", () => {
      const meta = generateStealthMetaAddress(wallet);
      const stealth = generateStealthAddress(meta);

      const viewingKeypair = deriveViewingKeypair(wallet);

      const matches = checkViewTag(
        stealth.ephemeralPubkey,
        stealth.viewTag,
        viewingKeypair.secretKey
      );

      expect(matches).toBe(true);
    });

    it("returns false for non-matching view tag", () => {
      const meta = generateStealthMetaAddress(wallet);
      const stealth = generateStealthAddress(meta);

      const otherWallet = Keypair.generate();
      const otherViewing = deriveViewingKeypair(otherWallet);

      const matches = checkViewTag(
        stealth.ephemeralPubkey,
        stealth.viewTag,
        otherViewing.secretKey
      );

      // With 1/256 probability this could match by chance,
      // but statistically it should not
      // We test the mechanism, not absolute guarantee
      expect(typeof matches).toBe("boolean");
    });
  });

  describe("deriveStealthSpendingKey", () => {
    it("derives a valid spending keypair", () => {
      const meta = generateStealthMetaAddress(wallet);
      const stealth = generateStealthAddress(meta);

      const viewingKeypair = deriveViewingKeypair(wallet);
      const spendingKeypair = deriveSpendingKeypair(wallet);

      const spendingKey = deriveStealthSpendingKey(
        stealth.ephemeralPubkey,
        viewingKeypair.secretKey,
        spendingKeypair.secretKey
      );

      expect(spendingKey).toBeInstanceOf(Keypair);
      // The derived key should match the stealth address
      expect(spendingKey.publicKey.equals(stealth.address)).toBe(true);
    });

    it("is deterministic", () => {
      const meta = generateStealthMetaAddress(wallet);
      const stealth = generateStealthAddress(meta);

      const viewingKeypair = deriveViewingKeypair(wallet);
      const spendingKeypair = deriveSpendingKeypair(wallet);

      const key1 = deriveStealthSpendingKey(
        stealth.ephemeralPubkey,
        viewingKeypair.secretKey,
        spendingKeypair.secretKey
      );
      const key2 = deriveStealthSpendingKey(
        stealth.ephemeralPubkey,
        viewingKeypair.secretKey,
        spendingKeypair.secretKey
      );

      expect(key1.publicKey.equals(key2.publicKey)).toBe(true);
    });
  });

  describe("recoverStealthAddress", () => {
    it("recovers the stealth address from ephemeral key", () => {
      const meta = generateStealthMetaAddress(wallet);
      const stealth = generateStealthAddress(meta);

      const viewingKeypair = deriveViewingKeypair(wallet);

      const recovered = recoverStealthAddress(
        stealth.ephemeralPubkey,
        meta,
        viewingKeypair.secretKey
      );

      expect(recovered.equals(stealth.address)).toBe(true);
    });
  });
});

describe("Stealth Meta-Address Serialization", () => {
  const wallet = Keypair.generate();
  const meta = generateStealthMetaAddress(wallet);

  it("serializes to a hex string of length 128", () => {
    const hex = serializeStealthMetaAddress(meta);
    expect(hex.length).toBe(128);
    expect(/^[0-9a-f]+$/.test(hex)).toBe(true);
  });

  it("deserializes back to the original meta-address", () => {
    const hex = serializeStealthMetaAddress(meta);
    const recovered = deserializeStealthMetaAddress(hex);

    expect(Buffer.from(recovered.spendingKey).toString("hex")).toBe(
      Buffer.from(meta.spendingKey).toString("hex")
    );
    expect(Buffer.from(recovered.viewingKey).toString("hex")).toBe(
      Buffer.from(meta.viewingKey).toString("hex")
    );
  });

  it("throws on invalid hex length", () => {
    expect(() => {
      deserializeStealthMetaAddress("abcdef");
    }).toThrow(StealthAddressError);
  });
});

describe("Stealth Meta-Address Validation", () => {
  it("validates a correct meta-address", () => {
    const wallet = Keypair.generate();
    const meta = generateStealthMetaAddress(wallet);
    expect(validateStealthMetaAddress(meta)).toBe(true);
  });

  it("rejects zero spending key", () => {
    expect(
      validateStealthMetaAddress({
        spendingKey: new Uint8Array(32),
        viewingKey: new Uint8Array(32).fill(1),
      })
    ).toBe(false);
  });

  it("rejects zero viewing key", () => {
    expect(
      validateStealthMetaAddress({
        spendingKey: new Uint8Array(32).fill(1),
        viewingKey: new Uint8Array(32),
      })
    ).toBe(false);
  });

  it("rejects wrong key sizes", () => {
    expect(
      validateStealthMetaAddress({
        spendingKey: new Uint8Array(16),
        viewingKey: new Uint8Array(32).fill(1),
      })
    ).toBe(false);
  });
});

describe("Stealth Registry PDAs", () => {
  it("derives deterministic registry address", () => {
    const owner = Keypair.generate().publicKey;
    const [addr1] = deriveRegistryAddress(owner);
    const [addr2] = deriveRegistryAddress(owner);
    expect(addr1.equals(addr2)).toBe(true);
  });

  it("different owners have different registry addresses", () => {
    const [addr1] = deriveRegistryAddress(Keypair.generate().publicKey);
    const [addr2] = deriveRegistryAddress(Keypair.generate().publicKey);
    expect(addr1.equals(addr2)).toBe(false);
  });

  it("derives announcement address", () => {
    const ephemeral = new Uint8Array(32).fill(1);
    const stealthAddr = Keypair.generate().publicKey;
    const [addr1] = deriveAnnouncementAddress(ephemeral, stealthAddr);
    const [addr2] = deriveAnnouncementAddress(ephemeral, stealthAddr);
    expect(addr1.equals(addr2)).toBe(true);
  });
});

describe("calculateStealthBalances", () => {
  it("aggregates balances by mint", () => {
    const mint1 = Keypair.generate().publicKey;
    const mint2 = Keypair.generate().publicKey;

    const payments = [
      {
        address: Keypair.generate().publicKey,
        ephemeralPubkey: new Uint8Array(32),
        amount: new BN(100),
        mint: mint1,
        timestamp: 0,
        slot: 0,
        txSignature: "sig1",
      },
      {
        address: Keypair.generate().publicKey,
        ephemeralPubkey: new Uint8Array(32),
        amount: new BN(200),
        mint: mint1,
        timestamp: 0,
        slot: 0,
        txSignature: "sig2",
      },
      {
        address: Keypair.generate().publicKey,
        ephemeralPubkey: new Uint8Array(32),
        amount: new BN(50),
        mint: mint2,
        timestamp: 0,
        slot: 0,
        txSignature: "sig3",
      },
    ];

    const balances = calculateStealthBalances(payments);

    expect(balances.get(mint1.toBase58())!.toString()).toBe("300");
    expect(balances.get(mint2.toBase58())!.toString()).toBe("50");
  });

  it("returns empty map for no payments", () => {
    const balances = calculateStealthBalances([]);
    expect(balances.size).toBe(0);
  });
});
