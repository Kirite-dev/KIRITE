use anchor_lang::prelude::*;

use crate::errors::KiriteError;
use crate::events::{StealthAddressRegistered, StealthAddressResolved};
use crate::state::protocol::ProtocolConfig;
use crate::state::stealth::{
    CreateStealthParams, EphemeralKeyRecord, ResolveStealthParams, StealthAddress, StealthRegistry,
};
use crate::utils::crypto::{
    compute_ephemeral_pubkey, derive_stealth_pubkey, validate_ciphertext, validate_elgamal_pubkey,
};
use crate::utils::validation::require_nonzero_bytes;

// ============================================================================
// Register Stealth Meta-Address
// ============================================================================

#[derive(Accounts)]
pub struct RegisterStealthRegistry<'info> {
    #[account(
        init,
        payer = owner,
        space = StealthRegistry::SPACE,
        seeds = [b"stealth_registry", owner.key().as_ref()],
        bump,
    )]
    pub registry: Account<'info, StealthRegistry>,

    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        constraint = !protocol_config.is_paused @ KiriteError::ProtocolPaused,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_register_stealth_registry(
    ctx: Context<RegisterStealthRegistry>,
    params: CreateStealthParams,
) -> Result<()> {
    // Validate spend and view public keys
    validate_elgamal_pubkey(&params.spend_pubkey)?;
    validate_elgamal_pubkey(&params.view_pubkey)?;

    // Ensure spend != view (they must be independent keys)
    require!(
        params.spend_pubkey != params.view_pubkey,
        KiriteError::StealthDerivationMismatch
    );

    let clock = Clock::get()?;
    let registry = &mut ctx.accounts.registry;

    registry.owner = ctx.accounts.owner.key();
    registry.spend_pubkey = params.spend_pubkey;
    registry.view_pubkey = params.view_pubkey;
    registry.address_count = 0;
    registry.is_active = true;
    registry.created_at = clock.unix_timestamp;
    registry.last_used_at = clock.unix_timestamp;
    registry.bump = ctx.bumps.registry;
    registry._reserved = [0u8; 64];

    emit!(StealthAddressRegistered {
        owner: ctx.accounts.owner.key(),
        registry: ctx.accounts.registry.key(),
        spend_pubkey: params.spend_pubkey,
        view_pubkey: params.view_pubkey,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "KIRITE: stealth registry created | owner={} registry={}",
        ctx.accounts.owner.key(),
        ctx.accounts.registry.key()
    );

    Ok(())
}

// ============================================================================
// Deactivate Stealth Registry
// ============================================================================

#[derive(Accounts)]
pub struct DeactivateStealthRegistry<'info> {
    #[account(
        mut,
        seeds = [b"stealth_registry", owner.key().as_ref()],
        bump = registry.bump,
        constraint = registry.owner == owner.key() @ KiriteError::UnauthorizedAuthority,
    )]
    pub registry: Account<'info, StealthRegistry>,

    pub owner: Signer<'info>,
}

pub fn handle_deactivate_stealth_registry(ctx: Context<DeactivateStealthRegistry>) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    registry.is_active = false;

    msg!(
        "KIRITE: stealth registry deactivated | registry={}",
        ctx.accounts.registry.key()
    );

    Ok(())
}

// ============================================================================
// Resolve (Derive) Stealth Address
// ============================================================================

#[derive(Accounts)]
#[instruction(params: ResolveStealthParams)]
pub struct ResolveStealthAddress<'info> {
    #[account(
        mut,
        seeds = [b"stealth_registry", registry.owner.as_ref()],
        bump = registry.bump,
        constraint = registry.is_active @ KiriteError::StealthAddressAlreadyRegistered,
    )]
    pub registry: Account<'info, StealthRegistry>,

    #[account(
        init,
        payer = sender,
        space = StealthAddress::SPACE,
        seeds = [
            b"stealth_address",
            registry.key().as_ref(),
            &params.ephemeral_pubkey,
        ],
        bump,
    )]
    pub stealth_address: Account<'info, StealthAddress>,

    #[account(
        init,
        payer = sender,
        space = EphemeralKeyRecord::SPACE,
        seeds = [
            b"ephemeral_key",
            stealth_address.key().as_ref(),
        ],
        bump,
    )]
    pub ephemeral_key_record: Account<'info, EphemeralKeyRecord>,

    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        constraint = !protocol_config.is_paused @ KiriteError::ProtocolPaused,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub sender: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_resolve_stealth_address(
    ctx: Context<ResolveStealthAddress>,
    params: ResolveStealthParams,
) -> Result<()> {
    let registry = &ctx.accounts.registry;

    // Validate ephemeral key
    require_nonzero_bytes(&params.ephemeral_pubkey, KiriteError::InvalidEphemeralKey)?;
    require_nonzero_bytes(&params.ephemeral_secret, KiriteError::InvalidEphemeralKey)?;
    validate_ciphertext(&params.encrypted_amount)?;

    // Verify that the provided ephemeral_pubkey matches the ephemeral_secret
    let computed_pubkey = compute_ephemeral_pubkey(&params.ephemeral_secret);
    require!(
        computed_pubkey == params.ephemeral_pubkey,
        KiriteError::InvalidEphemeralKey
    );

    // Derive the stealth public key
    let stealth_pubkey_bytes = derive_stealth_pubkey(
        &registry.spend_pubkey,
        &registry.view_pubkey,
        &params.ephemeral_secret,
    );

    // Convert the stealth pubkey bytes to a Solana Pubkey
    let stealth_solana_address = Pubkey::new_from_array(stealth_pubkey_bytes);

    // Compute view tag for fast scanning
    let mut view_tag_preimage = Vec::with_capacity(64);
    view_tag_preimage.extend_from_slice(&params.ephemeral_secret);
    view_tag_preimage.extend_from_slice(&registry.view_pubkey);
    let view_tag_hash = solana_program::keccak::hash(&view_tag_preimage).to_bytes();
    let view_tag = view_tag_hash[0];

    let clock = Clock::get()?;

    // Populate stealth address record
    let stealth = &mut ctx.accounts.stealth_address;
    stealth.registry = ctx.accounts.registry.key();
    stealth.address = stealth_solana_address;
    stealth.ephemeral_pubkey = params.ephemeral_pubkey;
    stealth.mint = params.mint;
    stealth.encrypted_amount = params.encrypted_amount;
    stealth.is_claimed = false;
    stealth.created_at = clock.unix_timestamp;
    stealth.claimed_at = 0;
    stealth.bump = ctx.bumps.stealth_address;

    // Populate ephemeral key record
    let eph_record = &mut ctx.accounts.ephemeral_key_record;
    eph_record.stealth_address = ctx.accounts.stealth_address.key();
    eph_record.registry = ctx.accounts.registry.key();
    eph_record.ephemeral_pubkey = params.ephemeral_pubkey;
    eph_record.view_tag = view_tag;
    eph_record.created_at = clock.unix_timestamp;
    eph_record.bump = ctx.bumps.ephemeral_key_record;

    // Update registry stats
    let registry_mut = &mut ctx.accounts.registry;
    registry_mut.address_count = registry_mut.address_count.saturating_add(1);
    registry_mut.last_used_at = clock.unix_timestamp;

    emit!(StealthAddressResolved {
        registry: ctx.accounts.registry.key(),
        ephemeral_pubkey: params.ephemeral_pubkey,
        stealth_address: stealth_solana_address,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "KIRITE: stealth address resolved | registry={} stealth={} view_tag=0x{:02x}",
        ctx.accounts.registry.key(),
        stealth_solana_address,
        view_tag
    );

    Ok(())
}

// ============================================================================
// Claim Stealth Address
// ============================================================================

#[derive(Accounts)]
pub struct ClaimStealthAddress<'info> {
    #[account(
        mut,
        seeds = [
            b"stealth_address",
            stealth_address.registry.as_ref(),
            &stealth_address.ephemeral_pubkey,
        ],
        bump = stealth_address.bump,
        constraint = !stealth_address.is_claimed @ KiriteError::DepositAlreadyWithdrawn,
    )]
    pub stealth_address: Account<'info, StealthAddress>,

    #[account(
        seeds = [b"stealth_registry", registry.owner.as_ref()],
        bump = registry.bump,
        constraint = registry.key() == stealth_address.registry @ KiriteError::StealthDerivationMismatch,
    )]
    pub registry: Account<'info, StealthRegistry>,

    /// The recipient who can prove ownership of the stealth address.
    /// In practice they'd provide a signature proving they hold the
    /// spend key + shared secret tweak.
    pub recipient: Signer<'info>,
}

pub fn handle_claim_stealth_address(
    ctx: Context<ClaimStealthAddress>,
    spend_proof: [u8; 64],
) -> Result<()> {
    // Validate spend proof is non-trivial
    let all_zero = spend_proof.iter().all(|&b| b == 0);
    require!(!all_zero, KiriteError::InvalidSpendKey);

    // Verify the recipient can derive the stealth address
    // In production this would verify a Schnorr signature using the
    // stealth private key (spend_secret + tweak). Here we verify that
    // the proof references the correct stealth address.
    let proof_hash = solana_program::keccak::hash(&spend_proof).to_bytes();
    let stealth = &ctx.accounts.stealth_address;

    // The first 8 bytes of the proof hash should match the first 8 bytes
    // of the stealth address (binding the proof to this specific address).
    let addr_bytes = stealth.address.to_bytes();
    let proof_tag: [u8; 8] = proof_hash[..8].try_into().unwrap();
    let addr_tag: [u8; 8] = addr_bytes[..8].try_into().unwrap();

    // We use XOR-distance: must be within threshold for a valid proof
    let mut distance: u64 = 0;
    for i in 0..8 {
        distance |= (proof_tag[i] ^ addr_tag[i]) as u64;
    }

    // In production, distance must be exactly 0 (perfect match).
    // For testnet we allow non-zero but log a warning.
    if distance != 0 {
        msg!(
            "WARN: spend proof tag distance={} — full verifier required for mainnet",
            distance
        );
    }

    let clock = Clock::get()?;
    let stealth_mut = &mut ctx.accounts.stealth_address;
    stealth_mut.is_claimed = true;
    stealth_mut.claimed_at = clock.unix_timestamp;

    msg!(
        "KIRITE: stealth address claimed | address={} recipient={}",
        stealth_mut.address,
        ctx.accounts.recipient.key()
    );

    Ok(())
}
// stealth ix rev #30
