# KIRITE Protocol — Deployment Guide

This document covers the full deployment lifecycle for the KIRITE privacy protocol on Solana, from local testing through mainnet launch.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Local Development](#local-development)
3. [Devnet Deployment](#devnet-deployment)
4. [Mainnet Deployment Checklist](#mainnet-deployment-checklist)
5. [Mainnet Deployment](#mainnet-deployment)
6. [Post-Deployment Verification](#post-deployment-verification)
7. [Protocol Initialization (Migration)](#protocol-initialization)
8. [IDL Publishing](#idl-publishing)
9. [Emergency Procedures](#emergency-procedures)
10. [Upgrade Procedures](#upgrade-procedures)
11. [Monitoring](#monitoring)

---

## Prerequisites

### Required Software

| Tool | Minimum Version | Purpose |
|------|----------------|---------|
| Rust | 1.75+ | Anchor/BPF compilation |
| Solana CLI | 1.18+ | Cluster interaction |
| Anchor CLI | 0.30+ | Build, deploy, IDL management |
| Node.js | 18+ | Migration scripts, SDK |
| jq | any | JSON processing in shell scripts |

### Installation

```bash
# Solana CLI
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# Anchor CLI
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install latest
avm use latest

# Verify
solana --version
anchor --version
```

### Wallet Setup

Generate a deployment keypair. **Store it securely; losing this key means losing upgrade authority.**

```bash
# Generate deployer keypair (one-time)
solana-keygen new --outfile ~/.config/solana/kirite-deployer.json

# For mainnet, use a hardware wallet or air-gapped machine
solana-keygen new --outfile /secure/path/kirite-mainnet-deployer.json
```

---

## Local Development

```bash
# Start local validator
solana-test-validator --reset

# Build and deploy locally
anchor build
anchor deploy

# Run tests
anchor test
```

---

## Devnet Deployment

### Step 1: Configure CLI

```bash
solana config set --url devnet
solana config set --keypair ~/.config/solana/kirite-deployer.json
```

### Step 2: Fund the deployer

```bash
solana airdrop 5 --url devnet
solana balance
```

### Step 3: Deploy

```bash
./scripts/deploy.sh devnet
```

### Step 4: Verify

```bash
./scripts/verify.sh devnet
```

### Step 5: Initialize protocol

```bash
npx ts-node scripts/migrate.ts --cluster devnet
```

### Step 6: Publish IDL

```bash
./scripts/idl-publish.sh devnet
```

---

## Mainnet Deployment Checklist

Complete every item before deploying to mainnet-beta.

### Security Audit

- [ ] Smart contract audit completed by a reputable firm (e.g., OtterSec, Neodyme, Halborn)
- [ ] All critical and high findings resolved
- [ ] Audit report published
- [ ] Re-audit after any changes to audited code

### Cryptographic Review

- [ ] Merkle tree implementation reviewed for soundness
- [ ] Nullifier scheme prevents double-spending under all edge cases
- [ ] ElGamal encryption parameters verified
- [ ] Stealth address derivation follows ERC-5564 adapted scheme
- [ ] Hash functions use Poseidon (ZK-friendly) or SHA-256 with proper domain separation

### Key Management

- [ ] Upgrade authority keypair generated on an air-gapped machine
- [ ] Keypair backed up in at least 2 geographically separate secure locations
- [ ] Multisig wallet created (Squads Protocol recommended)
  - Minimum 3-of-5 signers
  - Signers are independent parties
  - Each signer uses a hardware wallet
- [ ] Upgrade authority transferred to multisig after deployment
- [ ] Emergency pause authority assigned to a fast-response key (separate from multisig)

### Program Keypair

- [ ] Vanity program address generated (`solana-keygen grind --starts-with KRTE:1`)
- [ ] Program keypair securely stored
- [ ] Program ID updated in `Anchor.toml` and `app/deploy.toml`

### Testing

- [ ] Full test suite passes locally (`anchor test`)
- [ ] Devnet deployment tested end-to-end
- [ ] SDK integration tests pass against devnet
- [ ] Load testing performed (concurrent deposits/withdrawals)
- [ ] Timelock functionality verified
- [ ] Fee collection and burn mechanism verified
- [ ] Governance proposal lifecycle tested

### Operational

- [ ] RPC provider selected (Helius, Triton, or equivalent)
- [ ] Rate limiting configured on RPC endpoints
- [ ] Monitoring and alerting set up
- [ ] Incident response plan documented
- [ ] On-call rotation established

---

## Mainnet Deployment

### Step 1: Final build

Build in a reproducible environment to enable verifiable builds.

```bash
# Use anchor verify for reproducible builds
anchor build --verifiable

# Record the binary hash
sha256sum target/deploy/kirite.so
```

### Step 2: Pre-deployment balance check

Deploying a Solana program requires SOL for:
- Program account rent (~3-5 SOL depending on binary size)
- Buffer account during deployment
- Transaction fees

```bash
solana config set --url mainnet-beta
solana config set --keypair /secure/path/kirite-mainnet-deployer.json
solana balance
# Ensure at least 10 SOL available
```

### Step 3: Deploy

```bash
ANCHOR_WALLET=/secure/path/kirite-mainnet-deployer.json \
PROGRAM_KEYPAIR=target/deploy/kirite-keypair.json \
  ./scripts/deploy.sh mainnet-beta
```

### Step 4: Verify deployment

```bash
./scripts/verify.sh mainnet-beta
```

### Step 5: Initialize protocol

```bash
npx ts-node scripts/migrate.ts \
  --cluster mainnet-beta \
  --wallet /secure/path/kirite-mainnet-deployer.json
```

### Step 6: Transfer upgrade authority to multisig

```bash
# Get the Squads multisig address
MULTISIG_ADDR="<your-squads-multisig-address>"

solana program set-upgrade-authority \
  target/deploy/kirite-keypair.json \
  --new-upgrade-authority "$MULTISIG_ADDR" \
  --url mainnet-beta
```

### Step 7: Publish IDL

```bash
./scripts/idl-publish.sh mainnet-beta
```

### Step 8: Record deployment

Save the deployment receipt from `deployments/mainnet-beta/` and record:
- Program ID
- Deploy slot
- Binary SHA256
- Deployer pubkey
- Multisig authority address

---

## Post-Deployment Verification

### Automated checks

```bash
./scripts/verify.sh mainnet-beta <program-id>
```

### Manual checks

1. **Explorer verification**: Open the program on [Solscan](https://solscan.io) or [Solana Explorer](https://explorer.solana.com) and confirm:
   - Program is executable
   - Upgrade authority matches multisig
   - Account data size is reasonable

2. **SDK connectivity test**:
   ```typescript
   import { KiriteClient } from "@kirite/sdk";

   const client = new KiriteClient("mainnet-beta");
   const config = await client.getProtocolConfig();
   console.log("Fee:", config.feeBps, "bps");
   console.log("Pools:", config.totalPools);
   ```

3. **Deposit/withdraw cycle** (with small amount on devnet mirror):
   - Deposit 0.1 SOL into a shield pool
   - Wait for timelock to expire
   - Withdraw to a different wallet
   - Verify balances and fees

---

## Protocol Initialization

The migration script (`scripts/migrate.ts`) performs these steps:

1. **Initialize protocol config** — Sets authority, fee parameters (0.1% fee, 50% burn)
2. **Add supported mints** — Registers SOL, USDC, USDT
3. **Create shield pools** — Creates pools with fixed denominations:

   | Token | Denominations | Timelock |
   |-------|--------------|----------|
   | SOL | 0.1, 1, 10 | 1h, 1h, 2h |
   | USDC | 100, 1000, 10000 | 1h, 2h, 4h |
   | USDT | 100, 1000 | 1h, 2h |

4. **Configure governance** — Sets up signer requirements

### Dry run

```bash
npx ts-node scripts/migrate.ts --cluster mainnet-beta --dry-run
```

---

## IDL Publishing

The IDL (Interface Description Language) is published on-chain so that wallets, explorers, and other clients can decode instructions without bundling the IDL.

```bash
# First time
./scripts/idl-publish.sh mainnet-beta

# After program upgrade
./scripts/idl-publish.sh mainnet-beta  # auto-detects and upgrades
```

---

## Emergency Procedures

### Pause Protocol

If a vulnerability is discovered, pause all operations immediately.

```bash
# Using the CLI (requires authority keypair)
npx ts-node -e "
  const anchor = require('@coral-xyz/anchor');
  // ... setup provider
  await program.methods.pauseProtocol().accounts({...}).rpc();
"
```

Or via the SDK:

```typescript
import { KiriteClient } from "@kirite/sdk";

const client = new KiriteClient("mainnet-beta", authorityKeypair);
await client.pauseProtocol();
```

**Pause is immediate and does not require multisig if the emergency authority is set.**

### Freeze Individual Pool

To freeze a specific pool while keeping others operational:

```typescript
await client.freezePool(poolAddress, "Security review in progress");
```

### Resume After Pause

Resuming requires the protocol authority (multisig on mainnet):

```typescript
await client.resumeProtocol();
// or for individual pools:
await client.unfreezePool(poolAddress);
```

### Upgrade Authority Transfer

To transfer upgrade authority in an emergency (e.g., compromised key):

```bash
# Transfer to a new multisig
solana program set-upgrade-authority \
  <program-id> \
  --new-upgrade-authority <new-authority> \
  --url mainnet-beta \
  --keypair <current-authority-keypair>
```

### Make Program Immutable

As a last resort, renounce upgrade authority entirely. **This is irreversible.**

```bash
solana program set-upgrade-authority \
  <program-id> \
  --final \
  --url mainnet-beta \
  --keypair <current-authority-keypair>
```

### Authority Rotation (Governance)

To transfer protocol authority (not program upgrade authority) via the two-step process:

```typescript
// Step 1: Initiate transfer (current authority)
await program.methods
  .initiateAuthorityTransfer()
  .accounts({
    authority: currentAuthority.publicKey,
    protocolConfig: configPda,
    newAuthority: newAuthorityPubkey,
  })
  .signers([currentAuthority])
  .rpc();

// Step 2: Accept transfer (new authority)
await program.methods
  .acceptAuthorityTransfer()
  .accounts({
    newAuthority: newAuthority.publicKey,
    protocolConfig: configPda,
  })
  .signers([newAuthority])
  .rpc();
```

---

## Upgrade Procedures

### Standard Upgrade (via Multisig)

1. Build the new program version with verifiable builds:
   ```bash
   anchor build --verifiable
   ```

2. Create a Squads proposal for the upgrade:
   ```bash
   # Write the buffer
   solana program write-buffer target/deploy/kirite.so --url mainnet-beta

   # Create Squads upgrade proposal
   # (Use Squads UI or CLI to propose setting the buffer as the new program)
   ```

3. Collect required signatures from multisig members.

4. Execute the upgrade after timelock expires.

5. Verify the upgrade:
   ```bash
   ./scripts/verify.sh mainnet-beta
   anchor verify <program-id>
   ```

6. Update and republish IDL:
   ```bash
   ./scripts/idl-publish.sh mainnet-beta
   ```

### Rollback

Solana does not natively support rollback. To revert:

1. Build the previous version from the tagged git commit.
2. Deploy it as a standard upgrade via the multisig.

---

## Monitoring

### Key Metrics to Track

- **Program invocation count** — Sudden drops may indicate issues
- **Error rate** — Track failed transactions by error code
- **Pool balances** — Monitor vault balances vs. expected totals
- **Fee accumulation** — Verify fees are being collected correctly
- **Nullifier consumption rate** — Track anonymity set growth
- **Deposit/withdrawal ratio** — Unusual ratios may indicate attacks

### RPC Monitoring

```bash
# Check program account periodically
solana program show <program-id> --url mainnet-beta

# Monitor recent transactions
solana transaction-history <program-id> --url mainnet-beta --limit 20
```

### On-Chain Event Parsing

The KIRITE program emits events for all major operations. Index these events for monitoring dashboards:

- `ProtocolInitialized`
- `PoolCreated`
- `DepositMade`
- `WithdrawalMade`
- `ProtocolPaused`
- `ProtocolResumed`
- `FeeProposalCreated`
- `FeeProposalExecuted`
- `AuthorityTransferred`
<!-- deploy note --> #5
