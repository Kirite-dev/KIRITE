# KIRITE Protocol Specification

Version: 0.1.0-draft

---

## 1. Introduction

This document provides a formal specification of the KIRITE privacy protocol for Solana. It defines the instruction set, account layouts, cryptographic operations, security model, and threat analysis.

### 1.1 Notation

| Symbol | Meaning |
|--------|---------|
| `G` | Ristretto255 basepoint |
| `H` | Independent generator for Pedersen commitments |
| `s` | Recipient spend private key |
| `S` | Recipient spend public key (`s * G`) |
| `v` | Recipient view private key |
| `V` | Recipient view public key (`v * G`) |
| `r` | Random scalar (ephemeral) |
| `HASH()` | SHA-256 or domain-separated hash function |
| `bps` | Basis points (1 bps = 0.01%) |

---

## 2. Confidential Transfer Specification

### 2.1 Account Initialization

**Instruction**: `InitializeConfidentialAccount`

**Inputs**:
- `authority`: Signer, the wallet owner
- `mint`: The SPL token mint
- `elgamal_pubkey`: The owner's ElGamal public key (derived deterministically from the wallet keypair)

**Behavior**:
1. Derive PDA: `seeds = [b"confidential", authority, mint]`
2. Allocate account with space for `ConfidentialAccount`.
3. Set `encrypted_balance = Enc(0, elgamal_pubkey)`.
4. Set `pending_balance = Enc(0, elgamal_pubkey)`.
5. Set `nonce = 0`.

**Errors**:
- `AccountAlreadyInitialized` if the PDA already exists.

### 2.2 Deposit (Plaintext to Encrypted)

**Instruction**: `ConfidentialDeposit`

**Inputs**:
- `authority`: Signer
- `source_token_account`: Standard SPL token account
- `confidential_account`: The user's confidential account
- `amount`: u64, plaintext amount to deposit

**Behavior**:
1. Transfer `amount` from `source_token_account` to program vault via CPI to SPL Token.
2. Compute `encrypted_amount = Enc(amount, owner_elgamal_pubkey)`.
3. Update: `encrypted_balance += encrypted_amount` (homomorphic addition).
4. Increment `nonce`.

### 2.3 Confidential Transfer

**Instruction**: `ConfidentialTransfer`

**Inputs**:
- `authority`: Signer (sender)
- `sender_account`: Sender's `ConfidentialAccount`
- `recipient_account`: Recipient's `ConfidentialAccount`
- `encrypted_amount_sender`: Ciphertext under sender's key
- `encrypted_amount_recipient`: Ciphertext under recipient's key
- `range_proof`: Proof that amount is in `[0, 2^64)`
- `equality_proof`: Proof that both ciphertexts encrypt the same value
- `fee_ciphertext`: Encrypted fee amount (optional, for fee collection)

**Behavior**:
1. Verify `range_proof` for `encrypted_amount_sender`.
2. Verify `equality_proof` that `encrypted_amount_sender` and `encrypted_amount_recipient` encrypt the same plaintext.
3. Verify that `sender_account.encrypted_balance - encrypted_amount_sender` does not underflow (via range proof on the remaining balance).
4. Update: `sender_account.encrypted_balance -= encrypted_amount_sender`.
5. Update: `recipient_account.pending_balance += encrypted_amount_recipient`.
6. Deduct protocol fee from sender (encrypted).
7. Increment sender nonce.

**Errors**:
- `InvalidProof` if any proof fails verification.
- `InsufficientBalance` if the remaining balance range proof is invalid.
- `InvalidNonce` if nonce does not match.

### 2.4 Apply Pending Balance

**Instruction**: `ApplyPendingBalance`

**Inputs**:
- `authority`: Signer (account owner)
- `confidential_account`: The user's confidential account

**Behavior**:
1. Update: `encrypted_balance += pending_balance`.
2. Set `pending_balance = Enc(0)`.
3. Update `decryptable_balance` with a fresh encryption under the owner's key.

### 2.5 Withdraw (Encrypted to Plaintext)

**Instruction**: `ConfidentialWithdraw`

**Inputs**:
- `authority`: Signer
- `confidential_account`: The user's confidential account
- `destination_token_account`: Standard SPL token account
- `amount`: u64, plaintext amount to withdraw
- `range_proof`: Proof that remaining balance is non-negative

**Behavior**:
1. Compute `encrypted_amount = Enc(amount, owner_elgamal_pubkey)`.
2. Verify `range_proof` for `encrypted_balance - encrypted_amount`.
3. Update: `encrypted_balance -= encrypted_amount`.
4. Transfer `amount` from program vault to `destination_token_account`.
5. Increment nonce.

---

## 3. Shield Pool Specification

### 3.1 Pool Initialization

**Instruction**: `InitializePool`

**Inputs**:
- `authority`: Signer (admin multisig)
- `mint`: SPL token mint
- `denomination`: u64, fixed deposit amount
- `merkle_depth`: u8, depth of the Merkle tree (determines max deposits = 2^depth)

**Behavior**:
1. Derive pool PDA: `seeds = [b"pool", mint, denomination.to_le_bytes()]`.
2. Allocate Merkle tree account and nullifier set account.
3. Initialize tree with zero-value leaves (Poseidon hash of 0).
4. Set `next_index = 0`.

### 3.2 Pool Deposit

**Instruction**: `PoolDeposit`

**Inputs**:
- `depositor`: Signer
- `source_token_account`: Depositor's SPL token account
- `pool`: The `ShieldPool` account
- `commitment`: `[u8; 32]`, Pedersen commitment `C = HASH(nullifier, secret)`

**Behavior**:
1. Transfer `denomination` tokens from depositor to pool vault.
2. Insert `commitment` into the Merkle tree at index `next_index`.
3. Update `merkle_root`.
4. Increment `next_index`.
5. Emit event: `PoolDeposit { commitment, leaf_index, merkle_root }`.

**Notes**: The commitment is computed client-side. The program does not know the nullifier or secret.

### 3.3 Pool Withdrawal

**Instruction**: `PoolWithdraw`

**Inputs**:
- `recipient`: Pubkey (does not need to sign; can be any address)
- `pool`: The `ShieldPool` account
- `nullifier`: `[u8; 32]`
- `merkle_root`: `[u8; 32]`, the root at time of deposit (must be a recent valid root)
- `proof`: Zero-knowledge proof

**Proof statement** (verified by the program):

> "I know a `secret` and a `nullifier` such that:
> 1. `commitment = HASH(nullifier, secret)` is a leaf in the Merkle tree with root `merkle_root`.
> 2. The `nullifier` I am revealing corresponds to that commitment."

**Behavior**:
1. Verify `merkle_root` is a known recent root (stored ring buffer of last N roots).
2. Verify `nullifier` is not in the nullifier set.
3. Verify `proof` against public inputs `(merkle_root, nullifier, recipient)`.
4. Add `nullifier` to the nullifier set.
5. Transfer `denomination` tokens from pool vault to `recipient`.
6. Deduct protocol fee.
7. Emit event: `PoolWithdraw { nullifier, recipient }`.

**Errors**:
- `InvalidProof` if the ZK proof fails.
- `NullifierAlreadySpent` if the nullifier exists in the set.
- `UnknownMerkleRoot` if the root is not in the recent roots buffer.

---

## 4. Stealth Address Specification

### 4.1 Key Generation (Client-Side)

The recipient generates two keypairs:
- Spend keypair: `(s, S = s * G)`
- View keypair: `(v, V = v * G)`

The recipient publishes `(S, V)` as their stealth meta-address.

### 4.2 Address Derivation (Client-Side, by Sender)

1. Generate ephemeral scalar `r` and compute `R = r * G`.
2. Compute shared secret: `shared = HASH(r * V, nonce)`.
3. Compute one-time public key: `P = S + shared * G`.
4. The corresponding private key is `p = s + shared` (only the recipient can compute this).

### 4.3 Publish Stealth Metadata

**Instruction**: `PublishStealthMeta`

**Inputs**:
- `sender`: Signer
- `ephemeral_pubkey`: `R` (the ephemeral public key)
- `stealth_address`: `P` (the one-time address)
- `mint`: The token being sent

**Behavior**:
1. Allocate `StealthMeta` account with PDA `seeds = [b"stealth", ephemeral_pubkey]`.
2. Store `(R, P, mint, timestamp)`.
3. Sender transfers tokens to `P` via standard SPL Token transfer (or confidential transfer).

### 4.4 Scan for Payments (Client-Side)

1. Fetch all `StealthMeta` accounts (optionally filtered by timestamp range).
2. For each `(R, P, mint)`:
   a. Compute `shared = HASH(v * R, nonce)`.
   b. Compute `P' = S + shared * G`.
   c. If `P' == P`, this payment belongs to the recipient.
3. Derive the spending key: `p = s + shared`.

### 4.5 Claim Stealth Funds

**Instruction**: `ClaimStealth`

**Inputs**:
- `claimer`: Signer (must prove ownership of `P` by signing with `p`)
- `stealth_meta`: The `StealthMeta` account
- `stealth_token_account`: Token account owned by `P`
- `destination`: Claimer's main wallet token account

**Behavior**:
1. Verify `claimer` is the authority of `stealth_token_account`.
2. Transfer all tokens from `stealth_token_account` to `destination`.
3. Close `stealth_meta` account (return rent to claimer).

---

## 5. Security Model

### 5.1 Trust Assumptions

- **No trusted setup**: The Twisted ElGamal and Pedersen commitment schemes require no trusted setup. If Groth16 is used for pool proofs, a ceremony is required; alternatively, Plonk eliminates this requirement.
- **Solana runtime integrity**: The protocol trusts that the Solana runtime correctly executes BPF programs and enforces signer checks.
- **Client-side key management**: Private keys (spend key, view key, deposit secrets) are managed client-side. The protocol cannot protect against client compromise.
- **Cryptographic hardness**: Security relies on the discrete logarithm assumption over the Ristretto255 group.

### 5.2 Privacy Guarantees

| Property | Confidential Transfer | Shield Pool | Stealth Address |
|----------|----------------------|-------------|-----------------|
| Amount hidden | Yes | N/A (fixed denomination) | No (use with CT) |
| Sender hidden | No | Yes | No |
| Receiver hidden | No | Yes | Yes |
| Unlinkable payments | No | Yes | Yes |

### 5.3 What Is NOT Hidden

- Transaction existence (a transaction occurred on Solana)
- Transaction timing
- Gas payer identity
- Program interaction (observers know KIRITE was used)
- Token mint (which token is being transferred)

---

## 6. Threat Analysis

### 6.1 Transaction Graph Analysis

**Threat**: An observer correlates deposits and withdrawals by timing, amounts, or behavioral patterns.

**Mitigation**:
- Fixed denominations in Shield Pool prevent amount-based correlation.
- Users should wait for sufficient anonymity set growth before withdrawing.
- The SDK recommends randomized withdrawal delays.
- Multiple denomination tiers (e.g., 1 SOL, 10 SOL, 100 SOL) reduce the need for multi-deposit patterns.

### 6.2 Front-Running

**Threat**: A validator or MEV bot observes a withdrawal transaction in the mempool and front-runs it.

**Mitigation**:
- Nullifiers are deterministic. A front-runner cannot produce a valid proof for someone else's nullifier without knowing the secret.
- The withdrawal proof binds the recipient address. Changing the recipient invalidates the proof.

### 6.3 Timing Correlation

**Threat**: Deposit at time T, withdrawal at time T+delta with consistent delta reveals the depositor.

**Mitigation**:
- SDK includes configurable delay recommendations.
- The protocol does not enforce a minimum delay, but documentation strongly recommends waiting for at least N subsequent deposits (configurable, default 10).

### 6.4 Intersection Attack

**Threat**: If the anonymity set is small, an observer who knows partial information (e.g., "the withdrawer deposited in the last hour") can narrow down candidates.

**Mitigation**:
- Pool UI and SDK display anonymity set size.
- Warnings are shown when the anonymity set is below a threshold.
- Protocol can enforce minimum anonymity set size before allowing withdrawals (configurable parameter).

### 6.5 Malicious Recipient (Stealth Address)

**Threat**: A malicious party publishes a stealth address that they cannot actually spend from, tricking a sender into burning funds.

**Mitigation**:
- The stealth address is derived deterministically from the recipient's published spend key. If the recipient published a valid spend key, they can spend from any correctly derived stealth address.
- Senders should verify the recipient's meta-address through an authenticated channel.

### 6.6 View Key Compromise

**Threat**: An attacker obtains the recipient's view key.

**Impact**: The attacker can identify which stealth payments belong to the victim, but cannot spend them (requires the spend key).

**Mitigation**:
- View key and spend key are independent. View key compromise does not lead to fund loss.
- Users are advised to treat the view key as sensitive, though less critical than the spend key.

### 6.7 Quantum Resistance

**Status**: KIRITE's current cryptographic primitives (Ristretto255, Pedersen commitments) are not quantum-resistant. A future protocol version may migrate to lattice-based or hash-based alternatives as the Solana ecosystem adopts post-quantum standards.

---

## 7. Constants and Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| Curve | Ristretto255 | Implemented via `curve25519-dalek` |
| Hash function | Poseidon | For Merkle tree (ZK-friendly) |
| Hash function (general) | SHA-256 | For shared secrets, nullifiers |
| Merkle tree depth | 20 | Supports ~1M deposits per pool |
| Recent roots buffer | 100 | Number of historical roots accepted |
| Default CT fee | 10 bps | 0.1% |
| Max CT fee | 100 bps | 1.0% |
| Min anonymity set (recommended) | 10 | SDK-enforced warning threshold |

---

## 8. Instruction Summary

| Instruction | Program | Description |
|-------------|---------|-------------|
| `InitializeConfidentialAccount` | kirite | Create encrypted token account |
| `ConfidentialDeposit` | kirite | Plaintext to encrypted |
| `ConfidentialTransfer` | kirite | Encrypted to encrypted |
| `ApplyPendingBalance` | kirite | Merge pending into balance |
| `ConfidentialWithdraw` | kirite | Encrypted to plaintext |
| `InitializePool` | kirite | Create shield pool |
| `PoolDeposit` | kirite | Deposit into anonymity pool |
| `PoolWithdraw` | kirite | Withdraw with ZK proof |
| `PublishStealthMeta` | kirite | Publish ephemeral key on-chain |
| `ClaimStealth` | kirite | Claim stealth address funds |
| `UpdateConfig` | kirite | Update fee parameters (admin) |

---

## Appendix A: Account Sizes

| Account | Size (bytes) | Notes |
|---------|-------------|-------|
| ConfidentialAccount | 296 | Fixed |
| ShieldPool | 120 | Fixed |
| MerkleTree (depth 20) | ~67 MB | Allocated across multiple accounts |
| NullifierSet | Variable | Grows with withdrawals |
| StealthMeta | 136 | Fixed, reclaimable |
| ProtocolConfig | 96 | Fixed, singleton |

---

## Appendix B: Error Codes

| Code | Name | Description |
|------|------|-------------|
| 6000 | `InvalidProof` | ZK proof or range proof verification failed |
| 6001 | `InsufficientBalance` | Encrypted balance underflow |
| 6002 | `NullifierAlreadySpent` | Double-spend attempt |
| 6003 | `UnknownMerkleRoot` | Root not in recent roots buffer |
| 6004 | `AccountAlreadyInitialized` | Confidential account exists |
| 6005 | `InvalidNonce` | Replay protection triggered |
| 6006 | `PoolFull` | Merkle tree capacity reached |
| 6007 | `Unauthorized` | Signer is not the authority |
| 6008 | `InvalidDenomination` | Amount does not match pool denomination |
| 6009 | `InvalidMint` | Mint mismatch |
