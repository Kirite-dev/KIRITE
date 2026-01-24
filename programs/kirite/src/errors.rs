use anchor_lang::prelude::*;

#[error_code]
pub enum KiriteError {
    // === Authority & Access Control ===
    #[msg("Caller is not the protocol authority")]
    UnauthorizedAuthority,

    #[msg("Caller is not the pool operator")]
    UnauthorizedOperator,

    #[msg("Governance action requires quorum approval")]
    GovernanceQuorumNotMet,

    #[msg("Timelock period has not elapsed for this governance action")]
    GovernanceTimelockActive,

    #[msg("Protocol is currently paused")]
    ProtocolPaused,

    #[msg("This token mint is not supported by the protocol")]
    UnsupportedMint,

    // === Shield Pool ===
    #[msg("Shield pool has reached maximum capacity")]
    PoolCapacityExceeded,

    #[msg("Shield pool is not yet active")]
    PoolNotActive,

    #[msg("Shield pool has been permanently frozen")]
    PoolFrozen,

    #[msg("Deposit amount is below the pool minimum")]
    DepositBelowMinimum,

    #[msg("Deposit amount exceeds the pool maximum")]
    DepositAboveMaximum,

    #[msg("Deposit is still within the timelock period")]
    DepositTimelocked,

    #[msg("Deposit entry not found in the pool")]
    DepositNotFound,

    #[msg("Deposit has already been withdrawn")]
    DepositAlreadyWithdrawn,

    #[msg("Nullifier has already been consumed")]
    NullifierAlreadyUsed,

    #[msg("Provided Merkle proof is invalid")]
    InvalidMerkleProof,

    #[msg("Pool denomination does not match the provided amount")]
    DenominationMismatch,

    // === Confidential Transfer ===
    #[msg("Encrypted amount proof verification failed")]
    InvalidAmountProof,

    #[msg("Range proof verification failed — amount may be negative or overflow")]
    RangeProofFailed,

    #[msg("Ciphertext is malformed or uses an unsupported encoding")]
    MalformedCiphertext,

    #[msg("Sender has insufficient encrypted balance")]
    InsufficientEncryptedBalance,

    #[msg("Decryption key does not match the account's public key")]
    DecryptionKeyMismatch,

    #[msg("ElGamal public key is not on the curve")]
    InvalidElGamalKey,

    // === Stealth Address ===
    #[msg("Stealth address has already been registered")]
    StealthAddressAlreadyRegistered,

    #[msg("Stealth registry is full")]
    StealthRegistryFull,

    #[msg("Ephemeral public key is invalid")]
    InvalidEphemeralKey,

    #[msg("Stealth address derivation does not match the expected output")]
    StealthDerivationMismatch,

    #[msg("Scan key does not correspond to the registered stealth meta-address")]
    InvalidScanKey,

    #[msg("Spend key verification failed")]
    InvalidSpendKey,

    // === Fees & Math ===
    #[msg("Fee calculation resulted in overflow")]
    FeeOverflow,

    #[msg("Fee basis points exceed maximum allowed (10000)")]
    FeeBasisPointsExceedMax,

    #[msg("Arithmetic overflow in calculation")]
    MathOverflow,

    #[msg("Division by zero in calculation")]
    DivisionByZero,

    // === Validation ===
    #[msg("Input data exceeds maximum allowed length")]
    InputTooLong,

    #[msg("Account data length does not match expected size")]
    InvalidAccountSize,

    #[msg("Provided bump seed does not match the derived bump")]
    InvalidBump,

    #[msg("Timestamp is in the future or unreasonable")]
    InvalidTimestamp,

    #[msg("Nonce has already been used")]
    NonceReused,

    #[msg("Instruction data contains invalid enum variant")]
    InvalidVariant,
}
