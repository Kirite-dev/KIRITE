# examples

Runnable scripts demonstrating the KIRITE SDK. Requires a funded devnet wallet at `~/.config/solana/id.json`.

## Run

```bash
npx tsx examples/01-confidential-transfer.ts
npx tsx examples/02-shield-pool-deposit.ts
npx tsx examples/03-stealth-address.ts
```

## Scripts

| Script | Shows |
|---|---|
| `01-confidential-transfer.ts` | `kirite.confidentialTransfer()` with USDC mint |
| `02-shield-pool-deposit.ts` | `pool.deposit()` and persisting a note |
| `03-stealth-address.ts` | `stealth.generate()` and `stealth.scan()` flow |
