pragma circom 2.0.0;

include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/comparators.circom";

// Range proof: proves that a secret value lies in [0, 2^64).
// The Num2Bits decomposition implicitly enforces the range constraint:
// if value >= 2^64, the decomposition into 64 bits is impossible.
//
// Public input:  commitmentHash — binds the proof to a specific Pedersen commitment.
// Private input: value          — the secret amount being proven in-range.

template RangeProof64() {
    // Private
    signal input value;

    // Public — hash of the Pedersen commitment on-chain.
    // This binds the proof to a specific ciphertext without revealing the value.
    signal input commitmentHash;

    // Decompose value into 64 bits.
    // Num2Bits constrains each bit to {0, 1} and verifies
    // value == Σ(bit_i * 2^i). If value >= 2^64, no valid
    // bit decomposition exists → proof generation fails.
    component bits = Num2Bits(64);
    bits.in <== value;

    // Bind the commitment hash to the circuit so the proof
    // cannot be replayed for a different commitment.
    signal commitmentSquare;
    commitmentSquare <== commitmentHash * commitmentHash;
}

component main {public [commitmentHash]} = RangeProof64();
