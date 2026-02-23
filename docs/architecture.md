# KIRITE Architecture

This document describes the internal architecture of the KIRITE privacy protocol, its cryptographic primitives, account structures, and fee mechanisms.

---

## Overview

KIRITE implements three independent privacy layers on top of Solana's SPL Token standard. Each layer targets a different dimension of transaction privacy:

| Layer | Privacy Dimension | Primitive |
|-------|-------------------|-----------|
| Confidential Transfer | Amount privacy | Twisted ElGamal encryption |
| Shield Pool | Sender/receiver unlinkability | Commitment-based anonymity pool |
| Stealth Address | Recipient privacy | Diffie-Hellman one-time addresses |

Layers are composable. A single transaction can use any combination of the three.

---

## Layer 1: Confidential Transfer

### Purpose

Hides transfer amounts from all parties except the sender and receiver. Balances are stored encrypted on-chain. The Solana runtime never sees plaintext amounts.

### Cryptographic Primitive: Twisted ElGamal

Standard ElGamal encryption over the Ristretto255 curve, extended to support homomorphic addition. This allows the protocol to verify that encrypted balances are consistent (no inflation, no negative balances) without decrypting them.

**Encryption:**

```
Ciphertext = (r * G, amount * G + r * recipient_pubkey)
```

where `r` is a random scalar and `G` is the Ristretto255 basepoint.

**Homomorphic property:**

```
Enc(a) + Enc(b) = Enc(a + b)
```

This lets the program update encrypted balances by adding/subtracting encrypted amounts directly.

### Range Proofs

To prevent a sender from encrypting a negative value (which would create tokens out of thin air), each confidential transfer includes a Bulletproof-style range proof demonstrating that the encrypted amount is in `[0, 2^64)`.

### Account Structure

```
ConfidentialAccount
+---------------------------+
| authority: Pubkey          |  -- wallet that controls this account
| mint: Pubkey               |  -- SPL token mint
| encrypted_balance: [u8;64] |  -- Twisted ElGamal ciphertext
| pending_balance: [u8;64]   |  -- incoming transfers not yet applied
| decryptable_balance: [u8;64]| -- balance encrypted to owner for fast lookup
| nonce: u64                 |  -- replay protection
+---------------------------+
```

### Instructions

1. `initialize_confidential_account` -- Creates the on-chain account with a zero encrypted balance.
2. `deposit` -- Converts plaintext SPL tokens into an encrypted balance.
3. `confidential_transfer` -- Transfers an encrypted amount between two confidential accounts.
4. `apply_pending` -- Merges pending incoming transfers into the main balance.
5. `withdraw` -- Decrypts and withdraws tokens back to a standard SPL token account.

---

## Layer 2: Shield Pool

### Purpose

Breaks the on-chain link between sender and receiver. Even if amounts are encrypted, an observer can still trace which wallet sent to which wallet. The Shield Pool eliminates this by interposing a shared anonymity pool.

### Mechanism

1. **Deposit**: User deposits a fixed denomination into the pool. They receive a cryptographic commitment (a Pedersen commitment to the amount and a secret nullifier).
2. **Wait**: The deposit sits in the pool alongside other deposits of the same denomination, forming an anonymity set.
3. **Withdraw**: Using a zero-knowledge proof, the user proves they made a valid deposit without revealing which one. Funds are sent to any address.

The key insight: the withdrawal proof demonstrates membership in the set of all depositors without identifying which depositor is withdrawing.

### Cryptographic Primitives

- **Pedersen Commitments**: `C = amount * G + blinding * H` -- binds the depositor to an amount without revealing it.
- **Nullifiers**: A deterministic value derived from the deposit secret. Published on withdrawal to prevent double-spending.
- **Merkle Tree**: Deposits are inserted into an on-chain Merkle tree. The withdrawal proof demonstrates knowledge of a valid Merkle path.
- **ZK Proof**: A Groth16 or Plonk proof that verifies Merkle membership and nullifier correctness.

### Account Structure

```
ShieldPool
+---------------------------+
| mint: Pubkey               |  -- SPL token mint
| denomination: u64          |  -- fixed deposit size
| merkle_root: [u8;32]       |  -- current root of the deposit tree
| next_index: u32            |  -- next insertion index
| nullifier_set: Pubkey      |  -- account storing spent nullifiers
+---------------------------+

MerkleTree (separate account, large)
+---------------------------+
| levels: u8                 |  -- tree depth (e.g., 20 = 1M deposits)
| filled_subtrees: [[u8;32]] |  -- cached intermediate hashes
| leaves: [[u8;32]]          |  -- leaf commitments
+---------------------------+

NullifierSet (separate account)
+---------------------------+
| nullifiers: HashSet<[u8;32]>|  -- spent nullifiers
+---------------------------+
```

### Instructions

1. `initialize_pool` -- Creates a shield pool for a given mint and denomination.
2. `pool_deposit` -- Inserts a commitment into the Merkle tree and transfers tokens to the pool vault.
3. `pool_withdraw` -- Verifies the ZK proof, checks the nullifier has not been spent, sends tokens to the recipient.

### Anonymity Set

Privacy strength is directly proportional to the number of deposits in the pool. A pool with 10 deposits provides 10-anonymity (1-in-10 chance of identifying the withdrawer). KIRITE targets pools with thousands of deposits for meaningful privacy.

---

## Layer 3: Stealth Address

### Purpose

Prevents an observer from determining that two payments were sent to the same recipient. Each payment uses a fresh, one-time address that only the recipient can detect and spend from.

### Mechanism (Dual-Key Stealth Address Protocol)

The recipient publishes two public keys:

- **Spend key** `(S = s * G)`: used to spend received funds
- **View key** `(V = v * G)`: used to scan for incoming payments

**Sending:**

1. Sender generates a random ephemeral keypair `(r, R = r * G)`.
2. Sender computes shared secret: `shared = HASH(r * V)`.
3. Sender derives the one-time address: `P = S + shared * G`.
4. Sender sends funds to `P` and publishes `R` on-chain.

**Receiving:**

1. Recipient scans all published `R` values.
2. For each `R`, computes `shared = HASH(v * R)` (using the view private key).
3. Derives the expected one-time address: `P' = S + shared * G`.
4. If `P'` matches an on-chain account with funds, the payment belongs to them.
5. Recipient can spend using the derived private key: `p = s + shared`.

### Account Structure

```
StealthMeta
+---------------------------+
| ephemeral_pubkey: Pubkey   |  -- R, published by sender
| stealth_address: Pubkey    |  -- P, the one-time address
| mint: Pubkey               |  -- token being sent
| timestamp: i64             |  -- for scanning efficiency
+---------------------------+
```

### Instructions

1. `publish_stealth_meta` -- Sender publishes `R` and `P` on-chain.
2. `claim_stealth` -- Recipient proves ownership and transfers funds to their main wallet.

---

## Fee Mechanism

KIRITE charges protocol fees to sustain development and incentivize pool liquidity.

| Operation | Fee |
|-----------|-----|
| Confidential Transfer | 0.1% of transfer amount (capped) |
| Shield Pool Deposit | Fixed fee per deposit (denomination-dependent) |
| Shield Pool Withdrawal | Fixed fee per withdrawal |
| Stealth Address Publish | Solana rent + minimal protocol fee |
| Stealth Address Claim | No protocol fee |

Fees are collected in the transferred token and sent to a protocol-controlled treasury account. Fee parameters are governed by a multisig authority and can be updated without program upgrades via a configuration account.

### Fee Account Structure

```
ProtocolConfig
+---------------------------+
| authority: Pubkey          |  -- multisig that can update fees
| treasury: Pubkey           |  -- fee destination
| ct_fee_bps: u16            |  -- confidential transfer fee in basis points
| ct_fee_cap: u64            |  -- maximum fee per transfer
| pool_deposit_fee: u64      |  -- fixed deposit fee
| pool_withdraw_fee: u64     |  -- fixed withdrawal fee
| stealth_publish_fee: u64   |  -- stealth metadata publication fee
+---------------------------+
```

---

## Program Architecture

The on-chain program is built with Anchor and organized by feature:

```
programs/kirite/src/
  lib.rs                        -- program entrypoint, instruction dispatch
  instructions/
    mod.rs
    confidential_transfer.rs    -- CT instruction handlers
    shield_pool.rs              -- pool deposit/withdraw handlers
    stealth_address.rs          -- stealth publish/claim handlers
    admin.rs                    -- fee updates, pool initialization
  state/
    mod.rs
    confidential_account.rs     -- ConfidentialAccount struct
    shield_pool.rs              -- ShieldPool, MerkleTree, NullifierSet
    stealth_meta.rs             -- StealthMeta struct
    config.rs                   -- ProtocolConfig struct
  crypto/
    mod.rs
    twisted_elgamal.rs          -- encryption/decryption
    pedersen.rs                 -- Pedersen commitments
    range_proof.rs              -- Bulletproof range proofs
    merkle.rs                   -- Poseidon Merkle tree
    zk_verify.rs                -- ZK proof verification
  errors.rs                     -- Custom error codes
```

---

## Security Invariants

1. **No inflation**: The sum of all encrypted balances plus pool vault balances plus standard SPL balances for a given mint must always equal the total supply.
2. **No double-spend**: Each nullifier can only be used once. The nullifier set is checked on every withdrawal.
3. **No negative balances**: Range proofs enforce that all encrypted values are non-negative.
4. **Forward secrecy**: Stealth address ephemeral keys are used once and discarded. Compromising a view key reveals which payments were received but does not allow spending.
5. **Pool integrity**: The Merkle root is updated atomically with each deposit. Withdrawal proofs are verified against the current root.
