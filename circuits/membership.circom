pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/mux1.circom";

// Membership proof.
//
// Proves that the prover knows (nullifier_secret, blinding_factor) such
// that a leaf  commitment = Poseidon(ns, amount, bf, leaf_index)  is
// included in the Merkle tree whose root is publicly revealed, and
// publicly reveals  nullifier_hash = Poseidon(ns, leaf_index).
//
// Withdraw flow:
//   - On-chain verifier checks (proof, public_inputs).
//   - Public inputs: root, nullifier_hash, amount, recipient_hash.
//     Binding `recipient_hash` into the public inputs prevents a
//     watcher from "front-running" by replaying the proof to a
//     different recipient.
//   - Private inputs: nullifier_secret, blinding_factor, leaf_index,
//                     and the Merkle path siblings + indices.
//
// Tree height = 15 (32,768 leaves per pool). Matches the on-chain
// pool. The `Membership(15)` invocation at the bottom is the source
// of truth; the on-chain layout consumes the same height via
// MERKLE_TREE_HEIGHT = 15 in programs/kirite/src/utils/crypto.rs.

template MerklePathSelector() {
    signal input in[2];          // [current, sibling]
    signal input pathBit;        // 0 if current is the left child, 1 if right
    signal output out[2];        // [left, right] feeding the next Poseidon hash

    // mux: when pathBit==0 → left=current, right=sibling
    //      when pathBit==1 → left=sibling, right=current
    component mux0 = Mux1();
    component mux1 = Mux1();

    mux0.c[0] <== in[0];
    mux0.c[1] <== in[1];
    mux0.s   <== pathBit;
    out[0] <== mux0.out;

    mux1.c[0] <== in[1];
    mux1.c[1] <== in[0];
    mux1.s   <== pathBit;
    out[1] <== mux1.out;
}

template Membership(levels) {
    // Public
    signal input root;
    signal input nullifierHash;
    signal input amount;
    signal input recipientHash;

    // Private
    signal input nullifierSecret;
    signal input blindingFactor;
    signal input leafIndex;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // ------------------------------------------------------------------
    // 1. Compute the leaf commitment.
    //    commitment = Poseidon(nullifierSecret, amount, blindingFactor, leafIndex)
    // ------------------------------------------------------------------
    component leafHash = Poseidon(4);
    leafHash.inputs[0] <== nullifierSecret;
    leafHash.inputs[1] <== amount;
    leafHash.inputs[2] <== blindingFactor;
    leafHash.inputs[3] <== leafIndex;

    // ------------------------------------------------------------------
    // 2. Verify the Merkle path leads to the publicly-known root.
    // ------------------------------------------------------------------
    component selectors[levels];
    component hashers[levels];
    signal levelHash[levels + 1];

    levelHash[0] <== leafHash.out;

    for (var i = 0; i < levels; i++) {
        selectors[i] = MerklePathSelector();
        selectors[i].in[0] <== levelHash[i];
        selectors[i].in[1] <== pathElements[i];
        selectors[i].pathBit <== pathIndices[i];

        // Each pathBit must be a strict bit. Otherwise a malicious prover
        // could mix in fractional values to satisfy both branches.
        pathIndices[i] * (pathIndices[i] - 1) === 0;

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== selectors[i].out[0];
        hashers[i].inputs[1] <== selectors[i].out[1];

        levelHash[i + 1] <== hashers[i].out;
    }

    // The reconstructed root must equal the public root.
    levelHash[levels] === root;

    // ------------------------------------------------------------------
    // 3. Re-derive and bind the nullifier hash.
    //    nullifierHash = Poseidon(nullifierSecret, leafIndex)
    //    This is published on-chain to mark the leaf as spent. Because
    //    leafIndex enters both the leaf commitment and the nullifier
    //    hash, two distinct leaves can never share a nullifier.
    // ------------------------------------------------------------------
    component nullHash = Poseidon(2);
    nullHash.inputs[0] <== nullifierSecret;
    nullHash.inputs[1] <== leafIndex;
    nullifierHash === nullHash.out;

    // ------------------------------------------------------------------
    // 4. Bind amount + recipientHash into the proof. The values are
    //    public inputs already and any tampering by a watcher would
    //    invalidate the proof. We expose them via squared identities
    //    so the optimizer cannot drop the constraint.
    // ------------------------------------------------------------------
    signal amountSquared;
    amountSquared <== amount * amount;

    signal recipientSquared;
    recipientSquared <== recipientHash * recipientHash;
}

// Tree height matches on-chain MERKLE_TREE_HEIGHT.
component main {public [root, nullifierHash, amount, recipientHash]} = Membership(15);
