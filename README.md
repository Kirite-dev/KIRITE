<div align="center">

> [English](README.md) · [日本語](README.ja.md)

![KIRITE](./assets/banner.png)

<a href="https://github.com/Kirite-dev/KIRITE-layer/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-c8ff00?style=flat-square&cacheSeconds=3600&v=2" alt="MIT License"/></a>
<a href="https://github.com/Kirite-dev/KIRITE-layer/actions"><img src="https://img.shields.io/badge/build-passing-c8ff00?style=flat-square&cacheSeconds=3600&v=2" alt="build passing"/></a>
<a href="https://github.com/Kirite-dev/KIRITE-layer/releases"><img src="https://img.shields.io/badge/version-0.5.13-c8ff00?style=flat-square&cacheSeconds=3600&v=2" alt="v0.5.13"/></a>
<a href="https://www.npmjs.com/package/@kirite/sdk"><img src="https://img.shields.io/badge/npm-%40kirite%2Fsdk-c8ff00?style=flat-square&cacheSeconds=3600&v=2" alt="npm"/></a>
<a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/rust-1.85%2B-c8ff00?style=flat-square&cacheSeconds=3600&v=2" alt="rust 1.85+"/></a>
<a href="https://www.anchor-lang.com"><img src="https://img.shields.io/badge/anchor-0.31-c8ff00?style=flat-square&cacheSeconds=3600&v=2" alt="anchor 0.31"/></a>
<a href="https://x.com/KiriteDev"><img src="https://img.shields.io/badge/x-%40KiriteDev-c8ff00?style=flat-square&cacheSeconds=3600&v=2" alt="x @KiriteDev"/></a>
<a href="https://kirite.dev"><img src="https://img.shields.io/badge/website-kirite.dev-c8ff00?style=flat-square&cacheSeconds=3600&v=2" alt="kirite.dev"/></a>

</div>

---

**Solana wallets, but private.**

Send SOL to someone without your wallet, the amount, or the recipient address ever showing up on a block explorer in a linkable way. Drop SOL into a shared shield pool, the recipient gets it at a fresh one-time address, and the on-chain record shows two unrelated events instead of a transfer. Native Solana, no L2, no bridge.

The `$KIRITE` token captures protocol fees from private transfers and routes them to stakers.

> **Token CA:** `7iRJcjWHQMvdMXufPxLWBqfmBvikzETYTyjqnyCjpump` (Solana mainnet)

---

> The rest of this README is for developers, integrators, and ZK readers. End users should start at [kirite.dev/docs](https://kirite.dev/docs).

## Architecture

```mermaid
flowchart LR
    user[user wallet] -->|deposit| sp[Shield Pool]
    sp -->|Groth16 membership proof| relayer[Relayer]
    relayer -->|withdraw| sa[Stealth Address]
    sa -->|recipient claim| recipient[recipient wallet]

    sp -.->|Poseidon Merkle| onchain[Solana program]
    relayer -.->|OFAC SDN screening| screening[sanctions check]
```

Two pieces working together:

- **Shield Pool** — Poseidon-Merkle commitment pool. Deposits hash into a tree. Withdraws prove "I own one of the leaves" via a Groth16 zero-knowledge proof, without revealing which leaf. The chain only sees a nullifier hash and a Merkle root. The secret stays on the user's device.
- **Stealth Address** — Withdraws land on a one-time address derived from the recipient's public spend + view keys (DKSAP). The recipient scans for incoming notes with the view key alone. The recipient's main address never appears on-chain.

Built on Solana's native `alt_bn128` and `poseidon` syscalls. Browser-side proof generation via snarkjs WASM (~1s desktop, ~3s mobile). Non-custodial: the pool authority cannot move user funds.

## How privacy works

KIRITE breaks the deposit ↔ withdraw link and hides the recipient address. Notes stay on the user's device; the vault is PDA-locked.

Privacy requires sending in one of the fixed denominations: `0.01` / `0.05` / `0.1` / `1` / `10` SOL. Every deposit and withdraw in a pool moves the same exact amount, so observers cannot match a withdraw to its specific deposit. Anonymity is bounded by the active leaf count per pool (32,768 on v2 — Merkle height 15).

## Tech stack

- **On-chain:** Anchor / Rust, Solana native `alt_bn128` and `poseidon` syscalls
- **ZK circuits:** Circom + Groth16 over BN254, Hermez powers-of-tau ceremony
- **Client:** snarkjs WASM for browser proof generation (~1s desktop, ~3s mobile)
- **SDK:** TypeScript ([@kirite/sdk](https://www.npmjs.com/package/@kirite/sdk))
- **Relayer:** Vercel-hosted Node, OFAC SDN auto-refresh

## Build

Requires `solana-cli >= 2.1`, `anchor >= 0.31`, `rust >= 1.85`, `node >= 20`. The repo is **not a single monorepo** — programs and SDK build independently from the same source tree.

```bash
git clone https://github.com/Kirite-dev/KIRITE-layer.git
cd KIRITE-layer

# 1) on-chain programs (kirite privacy + kirite-staking)
anchor build
anchor test                       # optional, runs unit tests

# 2) TypeScript SDK (independent — does not depend on step 1)
cd sdk
npm install
npm run build
cd ..

# 3) examples (optional)
cd examples && npm install && cd ..
```

Each step is independent: `anchor build` writes Rust artifacts to `target/`, `npm run build` writes TS artifacts to `sdk/dist/`. There is no top-level command that builds everything in one call.

## Quick start (TypeScript SDK)

```bash
npm install @kirite/sdk @solana/web3.js
```

```typescript
import { Connection, Keypair } from "@solana/web3.js";
import {
  KIRITE_PROGRAM_ID,
  DEFAULT_DENOMINATIONS,
  generateStealthMetaAddress,
} from "@kirite/sdk";
import { deposit, withdraw } from "@kirite/sdk/zk";

const connection = new Connection("https://api.mainnet-beta.solana.com");
const wallet = Keypair.generate();

// publish a stealth meta-address (one-time setup per recipient)
const meta = generateStealthMetaAddress(wallet);

// deposit a fixed denomination into the shield pool
const denomination = DEFAULT_DENOMINATIONS[3]; // 1 SOL
const note = await deposit({ connection, payer: wallet, denomination });
// note.ns, note.bf, note.leafIndex → persist on the depositor's device

// later, withdraw to a stealth address (proof generated client-side)
const sig = await withdraw({
  connection,
  note,
  recipient: stealthAddress.address,
  relayerUrl: "https://relayer.kirite.dev",
});
```

Full SDK docs: [kirite.dev/docs/sdk](https://kirite.dev/docs/sdk).

## Project structure

```
KIRITE-layer/
├── programs/
│   ├── kirite/                # privacy program (shield pool + stealth)
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── instructions/  # deposit, withdraw, freeze
│   │       ├── state/         # ShieldPool, NullifierRecord
│   │       └── utils/
│   │           ├── zk.rs            # Groth16 verifier glue
│   │           └── membership_vk.rs # trusted-setup verifier key
│   └── kirite-staking/        # $KIRITE staking program (Token-2022)
├── circuits/
│   └── membership.circom      # Groth16 membership proof circuit
├── sdk/                       # @kirite/sdk on npm
│   └── src/
│       ├── kirite-zk.mjs      # v3 deposit/withdraw helpers
│       ├── staking.mjs        # staking instructions
│       ├── stealth/           # DKSAP utilities
│       ├── utils/
│       └── *.ts               # types, constants, errors
├── scripts/                   # operational helpers, init scripts
├── tests/                     # integration tests
└── docs/                      # protocol spec
```

## Anonymity-set bounds

| Active leaves | Upper bound on linkability per attempt |
| ------------- | -------------------------------------- |
| 1             | 100% (effectively transparent)         |
| 10            | 10%                                    |
| 100           | 1%                                     |
| 1,000         | 0.1%                                   |
| 32,768 (v2 cap) | ~0.003%                              |

These are upper bounds. Real-world adversaries combine timing and pattern analysis to narrow further. Practical privacy scales with traffic.

## Compliance

- **OFAC SDN auto-refresh** at the relayer (weekly Treasury XML pull)
- **Freeze authority** for emergency response (cannot move user funds, only halt new activity)
- **Public reporting channel:** `report@kirite.dev`
- Full posture: [kirite.dev/docs/compliance](https://kirite.dev/docs/compliance)

## Security

KIRITE has not yet undergone a third-party audit. The trusted setup uses the public Hermez powers-of-tau ceremony with a single Phase 2 contributor. A multi-party ceremony and a paid security review are planned follow-ons. Code is public and commit hashes verify against the deployed program.

For security disclosures, see [SECURITY.md](./SECURITY.md). Do not open public issues for security bugs.

## License

[MIT](./LICENSE)

## Links

- Website: https://kirite.dev
- Docs: https://kirite.dev/docs
- X: https://x.com/KiriteDev
- npm: https://www.npmjs.com/package/@kirite/sdk
- Ticker: $KIRITE (CA: `7iRJcjWHQMvdMXufPxLWBqfmBvikzETYTyjqnyCjpump`)
