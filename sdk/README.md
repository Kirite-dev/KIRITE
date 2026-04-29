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

TypeScript SDK for the [KIRITE](https://kirite.dev) privacy protocol on Solana. Tornado-style ZK shield pool + Monero-style stealth-address recipients, deployed Solana-native.

> **the signature exists. the hand does not.**

## Install

```bash
npm install @kirite/sdk @solana/web3.js
```

## What this package gives you

- **Types** for the on-chain program: `DepositNote`, `ShieldPoolState`, `StealthMetaAddress`, `StealthAddress`, `StealthPayment`, `Groth16Proof`, `WithdrawPublicInputs`
- **Constants** matching the deployed program: `KIRITE_PROGRAM_ID`, `DEFAULT_DENOMINATIONS` (0.01 / 0.05 / 0.1 / 1 / 10 SOL), `DEFAULT_TREE_DEPTH` (5), Merkle / nullifier seeds
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

const connection = new Connection("https://api.mainnet-beta.solana.com");

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

### Deposit and withdraw via the v3 ZK helpers

```ts
import { deposit, withdraw } from "@kirite/sdk/zk";

// note never leaves the device
const note = await deposit({ connection, payer: wallet, denomination });

// later, withdraw to a stealth address
const sig = await withdraw({
  connection,
  note,
  recipient: stealthAddress.address,
  relayerUrl: "https://relayer.kirite.dev",
});
```

### Stake $KIRITE

```ts
import { stake, unstake, claim } from "@kirite/sdk/staking";
import BN from "bn.js";

const sig = await stake({
  connection,
  owner: wallet,
  amount: new BN(1_000_000_000),
});
```

## Status

| Component                          | Status                                        |
| ---------------------------------- | --------------------------------------------- |
| `$KIRITE` token (Raydium)          | live on Solana mainnet                        |
| Staking program                    | deployed on Solana mainnet                    |
| Privacy program (Shield + Stealth) | end-to-end on devnet, mainnet rollout         |
| Relayer (OFAC screening)           | devnet, mainnet pending privacy program       |
| `@kirite/sdk` (this package)       | v0.5.x on npm                                 |

> Token CA: `7iRJcjWHQMvdMXufPxLWBqfmBvikzETYTyjqnyCjpump`

## Honest scope

KIRITE hides the deposit↔withdraw link and the recipient address. It does **not** hide amounts (each pool is fixed-denomination, uniformity is the privacy mechanism) and does **not** provide infinite anonymity (pools cap at 32 leaves on v1). Practical privacy scales with the active anonymity set.

For more, see the [KIRITE docs](https://kirite.dev/docs) and the [threat model](https://kirite.dev/docs/threat-model).

## Links

- 🌐 Website: [kirite.dev](https://kirite.dev)
- 📚 Docs: [kirite.dev/docs](https://kirite.dev/docs)
- 🔬 SDK reference: [kirite.dev/docs/sdk](https://kirite.dev/docs/sdk)
- 🐙 GitHub: [Kirite-dev/KIRITE-layer](https://github.com/Kirite-dev/KIRITE-layer)
- 𝕏 Twitter: [@KiriteDev](https://x.com/KiriteDev)
- 📦 npm: [@kirite/sdk](https://www.npmjs.com/package/@kirite/sdk)

## License

[MIT](https://github.com/Kirite-dev/KIRITE-layer/blob/main/LICENSE)
