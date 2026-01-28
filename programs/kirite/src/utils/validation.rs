use anchor_lang::prelude::*;

use crate::errors::KiriteError;
use crate::state::protocol::ProtocolConfig;

/// Maximum supported fee in basis points (100% = 10_000 bps).
pub const MAX_FEE_BPS: u16 = 10_000;

/// Maximum denomination for a shield pool (prevents overflow in fee math).
pub const MAX_DENOMINATION: u64 = 1_000_000_000_000_000; // 1B tokens with 6 decimals

/// Minimum denomination for a shield pool.
pub const MIN_DENOMINATION: u64 = 1_000; // dust threshold

/// Maximum number of supported mints in the protocol config.
pub const MAX_SUPPORTED_MINTS: usize = 32;

/// Minimum timelock duration in seconds (10 minutes).
pub const MIN_TIMELOCK_SECONDS: i64 = 600;

/// Maximum timelock duration in seconds (7 days).
pub const MAX_TIMELOCK_SECONDS: i64 = 604_800;

/// Governance proposal timelock (48 hours).
pub const GOVERNANCE_TIMELOCK_SECONDS: i64 = 172_800;

/// Maximum length for a pool freeze reason string.
pub const MAX_FREEZE_REASON_LEN: usize = 128;

// ============================================================================
// Protocol-level Validation
// ============================================================================

/// Ensure the protocol is not paused.
pub fn require_not_paused(config: &ProtocolConfig) -> Result<()> {
    require!(!config.is_paused, KiriteError::ProtocolPaused);
    Ok(())
}

/// Ensure the signer is the protocol authority.
pub fn require_authority(config: &ProtocolConfig, signer: &Pubkey) -> Result<()> {
    require!(
        config.authority == *signer,
        KiriteError::UnauthorizedAuthority
    );
    Ok(())
}

/// Ensure a mint is in the supported mints list.
pub fn require_supported_mint(config: &ProtocolConfig, mint: &Pubkey) -> Result<()> {
    let found = config
        .supported_mints
        .iter()
        .any(|m| m == mint);
    require!(found, KiriteError::UnsupportedMint);
    Ok(())
}

// ============================================================================
// Fee Validation
// ============================================================================

/// Validate that a fee value in basis points is within range.
pub fn validate_fee_bps(bps: u16) -> Result<()> {
    require!(bps <= MAX_FEE_BPS, KiriteError::FeeBasisPointsExceedMax);
    Ok(())
}

// ============================================================================
// Shield Pool Validation
// ============================================================================

/// Validate a pool denomination.
pub fn validate_denomination(denomination: u64) -> Result<()> {
    require!(
        denomination >= MIN_DENOMINATION,
        KiriteError::DepositBelowMinimum
    );
    require!(
        denomination <= MAX_DENOMINATION,
        KiriteError::DepositAboveMaximum
    );
    Ok(())
}

/// Validate that a timelock duration is within bounds.
pub fn validate_timelock_duration(seconds: i64) -> Result<()> {
    require!(
        seconds >= MIN_TIMELOCK_SECONDS,
        KiriteError::InvalidTimestamp
    );
    require!(
        seconds <= MAX_TIMELOCK_SECONDS,
        KiriteError::InvalidTimestamp
    );
    Ok(())
}

/// Check whether a deposit's timelock has expired.
pub fn is_timelock_expired(deposit_timestamp: i64, timelock_seconds: i64, now: i64) -> bool {
    now >= deposit_timestamp.saturating_add(timelock_seconds)
}

/// Validate a freeze reason string.
pub fn validate_freeze_reason(reason: &str) -> Result<()> {
    require!(
        reason.len() <= MAX_FREEZE_REASON_LEN,
        KiriteError::InputTooLong
    );
    require!(!reason.is_empty(), KiriteError::InputTooLong);
    Ok(())
}

// ============================================================================
// Cryptographic Input Validation
// ============================================================================

/// Validate that a 32-byte array is non-zero (e.g., for keys, hashes).
pub fn require_nonzero_bytes(data: &[u8; 32], err: KiriteError) -> Result<()> {
    let all_zero = data.iter().all(|&b| b == 0);
    if all_zero {
        return Err(err.into());
    }
    Ok(())
}

/// Validate a Merkle proof array has the correct length.
pub fn validate_merkle_proof_len(proof: &[[u8; 32]], expected_height: usize) -> Result<()> {
    require!(
        proof.len() == expected_height,
        KiriteError::InvalidMerkleProof
    );
    Ok(())
}

/// Validate a nullifier hash is non-zero.
pub fn validate_nullifier(nullifier: &[u8; 32]) -> Result<()> {
    require_nonzero_bytes(nullifier, KiriteError::NullifierAlreadyUsed)
}

/// Validate an ElGamal ciphertext byte array.
pub fn validate_ciphertext_bytes(ct: &[u8; 64]) -> Result<()> {
    let all_zero = ct.iter().all(|&b| b == 0);
    require!(!all_zero, KiriteError::MalformedCiphertext);
    Ok(())
}

// ============================================================================
// Timestamp Validation
// ============================================================================

/// Ensure a timestamp is not in the future (with 30s tolerance for clock drift).
pub fn validate_timestamp_not_future(ts: i64, current: i64) -> Result<()> {
    require!(ts <= current + 30, KiriteError::InvalidTimestamp);
    Ok(())
}

/// Ensure a governance timelock has elapsed.
pub fn require_governance_timelock_elapsed(
    proposal_timestamp: i64,
    current_timestamp: i64,
) -> Result<()> {
    let elapsed = current_timestamp.saturating_sub(proposal_timestamp);
    require!(
        elapsed >= GOVERNANCE_TIMELOCK_SECONDS,
        KiriteError::GovernanceTimelockActive
    );
    Ok(())
}

// ============================================================================
// Account Size Validation
// ============================================================================

/// Compute the space required for an Anchor account including the 8-byte discriminator.
pub fn account_space(data_len: usize) -> usize {
    8 + data_len
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_timelock_not_expired() {
        assert!(!is_timelock_expired(1000, 600, 1500));
    }

    #[test]
    fn test_timelock_expired() {
        assert!(is_timelock_expired(1000, 600, 1700));
    }

    #[test]
    fn test_timelock_exact_boundary() {
        assert!(is_timelock_expired(1000, 600, 1600));
    }

    #[test]
    fn test_validate_denomination_too_small() {
        assert!(validate_denomination(100).is_err());
    }

    #[test]
    fn test_validate_denomination_ok() {
        assert!(validate_denomination(1_000_000).is_ok());
    }
}
