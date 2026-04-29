# KIRITE phase-2 multi-party ceremony

Status: **open for contributions**

This directory tracks the multi-party phase-2 trusted-setup ceremony for the KIRITE membership circuit (`circuits/membership.circom`). The goal is to extend the existing single-contributor phase-2 zkey with independent contributions, so the resulting verifier key only requires that **one** contributor in the chain destroyed their entropy honestly.

## Why this matters

The on-chain Groth16 verifier in `programs/kirite/src/utils/membership_vk.rs` is derived from this zkey. If every phase-2 contributor in the chain colluded and kept their entropy, they could forge proofs and drain the shield pool. Each independent contributor we add removes one trust assumption.

## Status table

| round | contributor | sha256(zkey) | attestation |
| ----- | ----------- | ------------ | ----------- |
| 0     | kirite core (baseline) | `36d5cdec...e1a86d2f` | [round_0.attestation.txt](rounds/round_0.attestation.txt) |

(This table is appended one row per round as new contributions land.)

## How to contribute (5 minutes)

See [`CONTRIBUTOR_GUIDE.md`](./CONTRIBUTOR_GUIDE.md) (English) or [`CONTRIBUTOR_GUIDE.ko.md`](./CONTRIBUTOR_GUIDE.ko.md) for the exact commands.

Short version:

```bash
npm install -g snarkjs
wget https://raw.githubusercontent.com/Kirite-dev/KIRITE-layer/main/ceremony/rounds/round_<latest>.zkey
snarkjs zkey contribute round_<latest>.zkey round_<your_number>.zkey \
  --name="<your name or handle>" -v
# enter random keyboard mash when prompted

# open a PR adding round_<your_number>.zkey + round_<your_number>.attestation.txt
```

## What we need from contributors

- snarkjs running locally (Node 20+)
- ~5 minutes, ~50 MB of disk
- A name or handle for the attestation (a Twitter handle is fine)
- A public statement that you contributed (a tweet, a GitHub PR comment, anything that lets the community verify your participation)

You do **not** need to use KIRITE, hold the token, or know anything else about the project. The only thing that matters is that your entropy goes into the chain and you destroy it honestly.

## Verifying the ceremony

Anyone can verify the full chain with:

```bash
snarkjs zkey verify \
  circuits/membership.r1cs \
  circuits/build/pot14_final.ptau \
  ceremony/rounds/round_<latest>.zkey
```

If the chain verifies, every contribution between round_0 and round_<latest> is mathematically valid.

## Closing the ceremony

When the ceremony has enough contributors (target: 5+ external), the final zkey is fed into [`scripts/ceremony-finalize.mjs`](../scripts/ceremony-finalize.mjs), which regenerates `programs/kirite/src/utils/membership_vk.rs`. The on-chain program is then rebuilt and redeployed (devnet first, then mainnet at launch).

## Questions

DM [@KiriteDev](https://x.com/KiriteDev) or open a GitHub issue.

斬り手。
