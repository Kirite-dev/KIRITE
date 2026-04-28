<div align="center">

![KIRITE](https://raw.githubusercontent.com/Kirite-dev/KIRITE-layer/main/assets/banner.png)

# @kirite/sdk

**Solana 向けプライバシープロトコル · Solana-native privacy SDK**

<a href="https://www.npmjs.com/package/@kirite/sdk"><img src="https://img.shields.io/npm/v/@kirite/sdk?style=flat-square&color=c8ff00&label=npm" alt="npm"/></a>
<a href="https://www.npmjs.com/package/@kirite/sdk"><img src="https://img.shields.io/npm/dm/@kirite/sdk?style=flat-square&color=c8ff00&label=downloads" alt="downloads"/></a>
<a href="https://github.com/Kirite-dev/KIRITE-layer/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@kirite/sdk?style=flat-square&color=c8ff00" alt="MIT License"/></a>
<a href="https://github.com/Kirite-dev/KIRITE-layer"><img src="https://img.shields.io/badge/github-Kirite--dev%2FKIRITE--layer-c8ff00?style=flat-square" alt="github"/></a>
<a href="https://kirite.dev"><img src="https://img.shields.io/badge/website-kirite.dev-c8ff00?style=flat-square" alt="website"/></a>
<a href="https://x.com/KiriteDev"><img src="https://img.shields.io/badge/x-%40KiriteDev-c8ff00?style=flat-square" alt="x"/></a>

</div>

---

The TypeScript SDK for [KIRITE](https://kirite.dev). We packaged this up so you can integrate the privacy primitives into your own app, wallet, or backend without touching the on-chain program directly. The privacy program lives on Solana **devnet** today, so point your `Connection` at devnet to try the deposit / withdraw flow. Staking helpers target the live mainnet `$KIRITE` program.

## Install

```bash
npm install @kirite/sdk @solana/web3.js
```

## What this package gives you

- **Types** for the on-chain program: `DepositNote`, `ShieldPoolState`, `StealthMetaAddress`, `StealthAddress`, `StealthPayment`, `Groth16Proof`, `WithdrawPublicInputs`
- **Constants** matching the deployed program: `KIRITE_PROGRAM_ID`, `DEFAULT_DENOMINATIONS` (0.01 / 0.05 / 0.1 / 1 / 10 SOL), `DEFAULT_TREE_DEPTH` (15 — 32,768 leaves per pool), Merkle / nullifier seeds
- **Errors** that the on-chain program returns: `NullifierSpentError`, `TreeFullError`, `PoolFrozenError`, `InvalidDenominationError`, `RelayerError`, etc.
- **Stealth-address helpers**: DKSAP meta-address generation, ECDH derivation, view-tag fast scanning, on-chain registry interactions
- **Solana transport utilities**: connection helpers, transaction builder with priority-fee bumping, retry / backoff config
- **v3 ZK helpers** (`@kirite/sdk/zk`): Groth16 + Poseidon Merkle deposit/withdraw flow used in production. Browser proof generation via snarkjs WASM (~1s desktop, ~3s mobile)
- **Staking helpers** (`@kirite/sdk/staking`): non-custodial stake/unstake/claim instructions for the Token-2022 `$KIRITE` mint

## Architecture

<div align="center">

![KIRITE architecture](https://mermaid.ink/img/Zmxvd2NoYXJ0IExSCiAgICB1c2VyWyJ1c2VyIHdhbGxldCJdIC0tPnxkZXBvc2l0fCBzcFsiU2hpZWxkIFBvb2w8YnIvPlBvc2VpZG9uIE1lcmtsZSJdCiAgICBzcCAtLT58R3JvdGgxNiBwcm9vZnwgcmVsYXllclsiUmVsYXllcjxici8-T0ZBQyBTRE4iXQogICAgcmVsYXllciAtLT58d2l0aGRyYXcgdHh8IHNhWyJTdGVhbHRoIEFkZHJlc3M8YnIvPkRLU0FQIG9uZS10aW1lIl0KICAgIHNhIC0tPnxjbGFpbXwgcmVjaXBpZW50WyJyZWNpcGllbnQgd2FsbGV0Il0KICAgIGNsYXNzRGVmIGxpdmUgZmlsbDojYzhmZjAwLHN0cm9rZTojMGEwYTBhLGNvbG9yOiMwNjA2MDYKICAgIGNsYXNzRGVmIGdob3N0IGZpbGw6IzFhMWExYSxzdHJva2U6I2M4ZmYwMCxjb2xvcjojZmZmCiAgICBjbGFzcyB1c2VyLHJlY2lwaWVudCBsaXZlCiAgICBjbGFzcyBzcCxzYSxyZWxheWVyIGdob3N0?theme=dark&bgColor=060606)

</div>

## Quick start

### Resolve a pool by denomination

```ts
import { Connection, PublicKey } from "@solana/web3.js";
import {
  KIRITE_PROGRAM_ID,
  SEEDS,
  DEFAULT_DENOMINATIONS,
} from "@kirite/sdk";
import BN from "bn.js";

// privacy program lives on devnet; staking program is on mainnet
const connection = new Connection("https://api.devnet.solana.com");

const denomination = DEFAULT_DENOMINATIONS[3]; // 1 SOL
const [poolPda] = PublicKey.findProgramAddressSync(
  [SEEDS.POOL_STATE, denomination.toArrayLike(Buffer, "le", 8)],
  KIRITE_PROGRAM_ID
);
```

### Generate a stealth meta-address

```ts
import { Keypair } from "@solana/web3.js";
import { generateStealthMetaAddress } from "@kirite/sdk";

const wallet = Keypair.generate();
const meta = generateStealthMetaAddress(wallet);
// meta.spendingKey, meta.viewingKey  → publish to a recipient
```

### Build a deposit instruction

```ts
import { Transaction } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddress } from "@solana/spl-token";
import {
  buildDepositIx,
  buildComputeUnitLimitIx,
  deriveShieldPool,
  deriveVaultAuthority,
} from "@kirite/sdk/zk";
import {
  computeCommitment,
  randomFieldBytes,
} from "@kirite/sdk/zk";

// 1) local secrets — never leave the device
const ns = randomFieldBytes();
const bf = randomFieldBytes();
const leafIndex = /* pool.nextLeafIndex, read from pool state */;
const commitment = await computeCommitment(ns, denomination, bf, leafIndex);

// 2) Solana accounts
const [pool] = deriveShieldPool(NATIVE_MINT, denomination);
const [vaultAuth] = deriveVaultAuthority(pool);
const vault = await getAssociatedTokenAddress(NATIVE_MINT, vaultAuth, true);
const payerAta = await getAssociatedTokenAddress(NATIVE_MINT, wallet.publicKey);

// 3) instruction
const depIx = buildDepositIx({
  depositor: wallet.publicKey,
  depositorTokenAccount: payerAta,
  vault,
  shieldPool: pool,
  commitment,
});

const tx = new Transaction().add(buildComputeUnitLimitIx(600_000), depIx);
await connection.sendTransaction(tx, [wallet]);
```

For the full deposit → Groth16 proof → withdraw flow, see [`scripts/test-zk-e2e.mjs`](https://github.com/Kirite-dev/KIRITE-layer/blob/main/scripts/test-zk-e2e.mjs) — a runnable end-to-end script that exercises every primitive.

### Build a stake instruction

```ts
import { Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import {
  buildStakeIx,
  deriveStakingPool,
  deriveVaultAuthority,
} from "@kirite/sdk/staking";
import { KIRITE_TOKEN_MINT } from "@kirite/sdk";
import BN from "bn.js";

const [pool] = deriveStakingPool();
const [vaultAuth] = deriveVaultAuthority(pool);
const kiriteVault = await getAssociatedTokenAddress(KIRITE_TOKEN_MINT, vaultAuth, true);
const stakerKirite = await getAssociatedTokenAddress(KIRITE_TOKEN_MINT, wallet.publicKey);

const sig = await connection.sendTransaction(
  new Transaction().add(
    buildStakeIx({
      staker: wallet.publicKey,
      stakerKirite,
      kiriteVault,
      amount: new BN(1_000_000_000),
      lockDays: 30,
    }),
  ),
  [wallet],
);
```

`buildClaimIx` and `buildUnstakeIx` mirror the same pattern. See [`scripts/test-staking-e2e.mjs`](https://github.com/Kirite-dev/KIRITE-layer/blob/main/scripts/test-staking-e2e.mjs) for a runnable example.

> Token CA: `7iRJcjWHQMvdMXufPxLWBqfmBvikzETYTyjqnyCjpump`

## How privacy works

KIRITE breaks the deposit ↔ withdraw link and hides the recipient address. Privacy requires using one of the fixed denominations (`0.01` / `0.05` / `0.1` / `1` / `10` SOL). Every deposit and withdraw in a pool moves the same exact amount, so observers cannot match a withdraw to its specific deposit.

Practical privacy scales with the active anonymity set in each pool.

Full threat model: [kirite.dev/docs/threat-model](https://kirite.dev/docs/threat-model)

## Links

- 🌐 Website: [kirite.dev](https://kirite.dev)
- 📚 Docs: [kirite.dev/docs](https://kirite.dev/docs)
- 🔬 SDK reference: [kirite.dev/docs/sdk](https://kirite.dev/docs/sdk)
- 🐙 GitHub: [Kirite-dev/KIRITE-layer](https://github.com/Kirite-dev/KIRITE-layer)
- 𝕏 Twitter: [@KiriteDev](https://x.com/KiriteDev)
- 📦 npm: [@kirite/sdk](https://www.npmjs.com/package/@kirite/sdk)

## License

[MIT](https://github.com/Kirite-dev/KIRITE-layer/blob/main/LICENSE)
