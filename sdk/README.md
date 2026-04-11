# @kirite/sdk

TypeScript SDK for the KIRITE privacy protocol on Solana. Confidential transfers, shield pool deposits/withdrawals, and stealth address derivation.

## Install

```bash
git clone https://github.com/Kirite-dev/KIRITE-layer.git
cd KIRITE-layer/sdk
npm install
npm run build
```

## Quick Start

```ts
import { KiriteClient } from "@kirite/sdk";
import { Connection, Keypair } from "@solana/web3.js";

const connection = new Connection("https://api.devnet.solana.com");
const wallet = Keypair.generate();
const kirite = new KiriteClient(connection, wallet);

// Confidential transfer
const sig = await kirite.confidentialTransfer({
  mint: USDC_MINT,
  recipient: RECIPIENT_PUBKEY,
  amount: 100_000_000n,
});
// { signature: "5kF...x9q", encryptedAmount: Uint8Array, status: "confirmed" }
```

## Modules

| Module | Purpose |
|---|---|
| `client` | High-level entry point, wallet + RPC wiring |
| `confidential` | Twisted ElGamal encryption + transfer builder |
| `shield-pool` | Merkle commitments, deposit/withdraw flows |
| `stealth` | DKSAP address derivation + registry scanning |
| `utils` | Key management, transaction helpers |

## API

See source in [`src/`](src/). Full docs at [kirite.dev/docs](https://kirite.dev/docs).

## License

MIT
