use anchor_lang::prelude::*;

use crate::errors::KiriteError;

pub const BPS_DENOMINATOR: u64 = 10_000;
pub const MIN_FEE_LAMPORTS: u64 = 1;

/// fee = ceil(amount * fee_bps / 10_000), u128 intermediates for overflow safety.
pub fn calculate_fee(amount: u64, fee_bps: u16) -> Result<u64> {
    if fee_bps == 0 {
        return Ok(0);
    }
    if amount == 0 {
        return Ok(0);
    }

    let amount_u128 = amount as u128;
    let bps_u128 = fee_bps as u128;
    let denom_u128 = BPS_DENOMINATOR as u128;

    let numerator = amount_u128
        .checked_mul(bps_u128)
        .ok_or(KiriteError::FeeOverflow)?;
    let fee_u128 = numerator
        .checked_add(denom_u128 - 1)
        .ok_or(KiriteError::FeeOverflow)?
        .checked_div(denom_u128)
        .ok_or(KiriteError::DivisionByZero)?;

    let fee = u64::try_from(fee_u128).map_err(|_| KiriteError::FeeOverflow)?;

    Ok(fee.max(MIN_FEE_LAMPORTS))
}

pub fn calculate_net_amount(gross_amount: u64, fee_bps: u16) -> Result<(u64, u64)> {
    let fee = calculate_fee(gross_amount, fee_bps)?;
    let net = gross_amount
        .checked_sub(fee)
        .ok_or(KiriteError::MathOverflow)?;
    Ok((net, fee))
}

pub fn split_fee(fee: u64, burn_ratio_bps: u16) -> Result<(u64, u64)> {
    if fee == 0 {
        return Ok((0, 0));
    }

    let fee_u128 = fee as u128;
    let ratio_u128 = burn_ratio_bps as u128;
    let denom_u128 = BPS_DENOMINATOR as u128;

    let burn_u128 = fee_u128
        .checked_mul(ratio_u128)
        .ok_or(KiriteError::FeeOverflow)?
        .checked_div(denom_u128)
        .ok_or(KiriteError::DivisionByZero)?;

    let burn = u64::try_from(burn_u128).map_err(|_| KiriteError::FeeOverflow)?;
    let treasury = fee.checked_sub(burn).ok_or(KiriteError::MathOverflow)?;

    Ok((burn, treasury))
}

pub fn compute_unlock_time(deposit_timestamp: i64, timelock_seconds: i64) -> Result<i64> {
    deposit_timestamp
        .checked_add(timelock_seconds)
        .ok_or_else(|| error!(KiriteError::MathOverflow))
}

pub fn remaining_timelock(deposit_timestamp: i64, timelock_seconds: i64, now: i64) -> Result<i64> {
    let unlock = compute_unlock_time(deposit_timestamp, timelock_seconds)?;
    if now >= unlock {
        Ok(0)
    } else {
        Ok(unlock.saturating_sub(now))
    }
}

pub fn nullifier_byte_index(leaf_index: u32) -> usize {
    (leaf_index / 8) as usize
}

pub fn nullifier_bit_mask(leaf_index: u32) -> u8 {
    1u8 << (leaf_index % 8)
}

pub fn safe_add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| error!(KiriteError::MathOverflow))
}

pub fn safe_sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b)
        .ok_or_else(|| error!(KiriteError::MathOverflow))
}

pub fn safe_mul(a: u64, b: u64) -> Result<u64> {
    a.checked_mul(b)
        .ok_or_else(|| error!(KiriteError::MathOverflow))
}

pub fn safe_div(a: u64, b: u64) -> Result<u64> {
    if b == 0 {
        return Err(error!(KiriteError::DivisionByZero));
    }
    Ok(a / b)
}

pub fn lerp_bps(a: u64, b: u64, t_bps: u16) -> Result<u64> {
    if t_bps == 0 {
        return Ok(a);
    }
    if t_bps >= 10_000 {
        return Ok(b);
    }
    let a128 = a as u128;
    let b128 = b as u128;
    let t128 = t_bps as u128;

    let diff = if b128 >= a128 {
        b128 - a128
    } else {
        a128 - b128
    };
    let scaled = diff.checked_mul(t128).ok_or(KiriteError::MathOverflow)? / BPS_DENOMINATOR as u128;

    let result = if b128 >= a128 {
        a128 + scaled
    } else {
        a128 - scaled
    };

    u64::try_from(result).map_err(|_| error!(KiriteError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fee_10bps_on_1_sol() {
        // 10 bps = 0.1% of 1_000_000_000 = 1_000_000
        let fee = calculate_fee(1_000_000_000, 10).unwrap();
        assert_eq!(fee, 1_000_000);
    }

    #[test]
    fn test_fee_zero_amount() {
        let fee = calculate_fee(0, 10).unwrap();
        assert_eq!(fee, 0);
    }

    #[test]
    fn test_fee_zero_bps() {
        let fee = calculate_fee(1_000_000, 0).unwrap();
        assert_eq!(fee, 0);
    }

    #[test]
    fn test_fee_ceiling() {
        // 1 bps on 99 tokens: 99 * 1 / 10000 = 0.0099 -> ceil = 1 (also matches min)
        let fee = calculate_fee(99, 1).unwrap();
        assert_eq!(fee, 1);
    }

    #[test]
    fn test_net_amount() {
        // 10 bps on 1M = 1M * 10 / 10000 = 1000
        let (net, fee) = calculate_net_amount(1_000_000, 10).unwrap();
        assert_eq!(fee, 1000);
        assert_eq!(net, 999_000);
    }

    #[test]
    fn test_split_fee_50_50() {
        let (burn, treasury) = split_fee(1000, 5000).unwrap();
        assert_eq!(burn, 500);
        assert_eq!(treasury, 500);
    }

    #[test]
    fn test_remaining_timelock_not_expired() {
        let remaining = remaining_timelock(1000, 600, 1200).unwrap();
        assert_eq!(remaining, 400);
    }

    #[test]
    fn test_remaining_timelock_expired() {
        let remaining = remaining_timelock(1000, 600, 2000).unwrap();
        assert_eq!(remaining, 0);
    }

    #[test]
    fn test_lerp_midpoint() {
        let val = lerp_bps(100, 200, 5000).unwrap();
        assert_eq!(val, 150);
    }
}
// math rev #27
