# Contributing to the KIRITE phase-2 ceremony

This guide walks through one contribution to the KIRITE membership-circuit phase-2 trusted-setup ceremony. The whole process takes about five minutes.

## What you are doing

You will take the latest zkey, mix in your own random entropy, and produce a new zkey that goes one step deeper into the ceremony. After your contribution lands, the only way an attacker can forge proofs against the resulting verifier is if every contributor in the chain (including you) kept their entropy. As long as you destroy yours, the chain is safe regardless of what anyone else did.

## Requirements

- Node.js 20 or newer
- About 50 MB of disk
- A name or handle for the attestation (a Twitter handle is fine)
- A way to publicly post that you contributed (a tweet, a GitHub PR comment, anything verifiable)

## Steps

### 1. Install snarkjs

```bash
npm install -g snarkjs
```

If you already have it, make sure it is recent (`snarkjs --version` should show 0.7+).

### 2. Pull the latest zkey

Look at the [ceremony status table](./README.md#status-table) and find the latest round number. Then download that file from the repo:

```bash
wget https://raw.githubusercontent.com/Kirite-dev/KIRITE-layer/main/ceremony/rounds/round_<N>.zkey
```

Replace `<N>` with the latest round number. For example, if round_3 is the latest, you download `round_3.zkey` and your contribution will produce `round_4.zkey`.

### 3. Contribute

Run the contribution command. Pick a name or handle for the attestation:

```bash
snarkjs zkey contribute round_<N>.zkey round_<N+1>.zkey \
  --name="<your name or handle>" \
  -v
```

When snarkjs prompts you, **mash the keyboard with random characters**. Anything is fine. Hit enter. snarkjs will combine that with the OS RNG and produce the new zkey. This takes about a minute.

The terminal will print a contribution hash that looks like a long hex string. Save that. It is your attestation hash.

### 4. Compute the sha256 of the new zkey

```bash
sha256sum round_<N+1>.zkey
```

Save the digest. It goes in your attestation file.

### 5. Write your attestation

Create `round_<N+1>.attestation.txt` with this template:

```
round: <N+1>
contributor: <your name or handle>
date: <YYYY-MM-DD>
sha256(zkey): <digest from step 4>
contribution_hash: <hash printed by snarkjs in step 3>
public_statement: <link to a tweet or GitHub comment confirming this is you>

(optional) machine notes: e.g., "fresh ubuntu VM, OS RNG only, machine destroyed after"
```

### 6. Open a PR

Fork the repo, push these two files into `ceremony/rounds/`:

- `round_<N+1>.zkey`
- `round_<N+1>.attestation.txt`

Then open a pull request titled `ceremony: round <N+1> contribution by <your handle>`.

A reviewer will run `snarkjs zkey verify` on your file and merge if it checks out. The status table in the ceremony README is updated at merge.

### 7. Destroy your entropy

This is the part that actually matters. Anything that touched your entropy needs to go away:

- Wipe the keyboard input out of your terminal scrollback
- Delete the local `round_<N>.zkey` and `round_<N+1>.zkey` from your disk if you want
- If you ran inside a VM, destroy the VM
- Most importantly: do not write the entropy down anywhere

The whole reason this ceremony works is that even one honest contributor breaks the chain of trust an attacker would need.

### 8. Post publicly

Tweet, post in a Discord, drop a GitHub comment, anything. Something like:

> contributed to KIRITE phase-2 ceremony round <N+1>
> sha256(zkey): <digest>
> contribution_hash: <hash>

This is what the community uses to verify that the name on the attestation is really you and not someone impersonating you.

## Verifying your own contribution

If you want to be extra sure your contribution went into a valid chain, run:

```bash
snarkjs zkey verify \
  circuits/membership.r1cs \
  circuits/build/pot14_final.ptau \
  round_<N+1>.zkey
```

It will print `ZKey OK!` if the chain (including your contribution) is valid back to the powers-of-tau ceremony.

## Questions

DM [@KiriteDev](https://x.com/KiriteDev) or comment on the PR.

斬り手。
