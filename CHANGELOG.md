# Changelog

All notable changes to KIRITE Protocol are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Configurable privacy levels (instant / standard / maximum) at withdrawal time
- View key support for selective disclosure to auditors
- Multi-asset shield pool with per-mint anonymity sets

### Changed
- Reduced default protocol fee from 0.15% to 0.1%
- Stack-optimized deposit instruction for lower compute units
- Merkle tree height tunable per pool

### Fixed
- Edge case in nullifier set when bitfield needs extension
- Off-by-one in withdrawal proof verification for last leaf

## [0.1.0] - 2026-04-08

### Added
- Initial Solana program (Anchor / Rust)
- Confidential Transfer instruction with Twisted ElGamal encryption
- Shield Pool with Merkle tree commitment scheme
- Stealth Address registry with ECDH dual-key derivation
- Governance instructions: pause, resume, fee management, mint whitelist
- TypeScript SDK with `KiriteClient`, `ShieldPool`, `StealthAddress`
- CLI tool with `init`, `transfer`, `pool deposit`, `pool withdraw`, `stealth` commands
- Devnet deployment scripts
- IDL publishing pipeline
- 28 on-chain integration tests
- Architecture, protocol spec, and deployment guide documentation

[Unreleased]: https://github.com/KIRITE-labs/kirite-protocol/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/KIRITE-labs/kirite-protocol/releases/tag/v0.1.0
