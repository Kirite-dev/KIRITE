# programs/kirite

On-chain Anchor program for the KIRITE privacy protocol.

**Program ID (devnet):** `4bUHrDPuRcoYPU7UTLojXtxJsWoCj3HJbKX9oLnEnYy6`

## Build

```bash
anchor build
```

## Instructions

| Instruction | Purpose |
|---|---|
| `initialize_protocol` | Bootstrap protocol config + governance |
| `create_confidential_account` | Register an ElGamal pubkey for confidential balances |
| `confidential_transfer` | Encrypted amount transfer with range + equality proof |
| `create_shield_pool` | Deploy a new multi-asset anonymity pool |
| `deposit` | Insert a Pedersen commitment into the Merkle tree |
| `withdraw` | Spend a commitment via nullifier + Merkle proof |
| `create_stealth_registry` | Publish spend + view keys for stealth address flow |
| `resolve_stealth` | Scan ephemeral registry entries with a view key |
| `pause` / `resume` | Emergency pause (governance-gated) |
| `update_fees` | Adjust fee bps (governance-gated) |

## Accounts

- `ProtocolConfig` — fees, authority, paused flag
- `GovernanceState` — multisig-style signers
- `ConfidentialAccount` — encrypted balance per mint
- `ShieldPool` — merkle root + denomination config
- `ShieldPoolEntry` — individual commitment leaf
- `StealthRegistry` — spend/view key pair
- `EphemeralKeyRecord` — per-tx ephemeral pubkey

## Errors

See [`src/errors.rs`](src/errors.rs). Custom `KiriteError` enum with variants for
pause state, unauthorized authority, overflow, invalid proofs, etc.

## IDL

Generated IDL is committed at [`idl/kirite.json`](idl/kirite.json) for ecosystem
trackers. Regenerate with `anchor build`.
