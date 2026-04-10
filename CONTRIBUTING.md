# Contributing to KIRITE

Thank you for your interest in contributing to the KIRITE privacy protocol. This document provides guidelines and instructions for contributing.

## Table of Contents

- [Development Environment Setup](#development-environment-setup)
- [Code Style Guidelines](#code-style-guidelines)
- [Pull Request Process](#pull-request-process)
- [Issue Reporting](#issue-reporting)

---

## Development Environment Setup

### Prerequisites

- **Rust** 1.75+ with `rustfmt` and `clippy`
- **Node.js** 18+ with npm
- **Solana CLI** 1.17+
- **Anchor** 0.29+

### Clone and Build

```bash
git clone https://github.com/MAH/kirite.git
cd kirite
```

### On-Chain Program

```bash
anchor build
anchor test
```

### TypeScript SDK

```bash
cd sdk/
npm install
npm run build
npm test
```

### CLI

```bash
cd cli/
cargo build --release
cargo test
```

### Local Validator

For integration testing, run a local Solana validator:

```bash
solana-test-validator --reset
```

Then deploy the program locally:

```bash
anchor deploy --provider.cluster localnet
```

---

## Code Style Guidelines

### Rust

- Run `cargo fmt` before every commit. CI will reject unformatted code.
- Run `cargo clippy -- -D warnings` and fix all warnings.
- Use `snake_case` for functions and variables, `PascalCase` for types and structs.
- Document all public functions and types with `///` doc comments.
- Keep functions under 50 lines where possible. Extract helpers.
- Error types must implement descriptive messages. Use Anchor's `#[error_code]` macro.
- Unsafe code is not permitted without explicit review and justification.

```rust
// Good
/// Encrypts a transfer amount using Twisted ElGamal.
///
/// Returns the ciphertext and the randomness used for encryption.
pub fn encrypt_transfer_amount(
    amount: u64,
    pubkey: &ElGamalPubkey,
) -> Result<(ElGamalCiphertext, PedersenOpening)> {
    // ...
}
```

### TypeScript

- Use TypeScript strict mode (`"strict": true`).
- Use `eslint` with the project configuration.
- Prefer `const` over `let`. Never use `var`.
- Use explicit return types on exported functions.
- Use `camelCase` for variables and functions, `PascalCase` for classes and types.
- All public SDK methods must include JSDoc comments.

```typescript
// Good
/**
 * Deposits tokens into the shield pool.
 * @param mint - SPL token mint address
 * @param amount - Amount in smallest token unit
 * @returns Deposit note containing commitment and nullifier
 */
export async function deposit(
  mint: PublicKey,
  amount: number,
): Promise<DepositNote> {
  // ...
}
```

### Commit Messages

- Use the imperative mood: "add feature" not "added feature"
- First line: max 72 characters, concise summary
- Body (optional): explain *why*, not *what*
- Reference issue numbers where applicable: `fixes #42`

```
add stealth address scanning to CLI

Implements the `stealth scan` subcommand that iterates over recent
transactions and identifies payments to the user's stealth addresses
using the view key. Fixes #18.
```

---

## Pull Request Process

1. **Fork** the repository and create a feature branch from `main`.
2. **Branch naming**: use `feat/`, `fix/`, `docs/`, or `refactor/` prefixes.
   - Example: `feat/stealth-address-scan`, `fix/pool-withdraw-race`
3. **Write tests** for any new functionality. PRs without tests for new features will not be merged.
4. **Ensure CI passes**: `cargo fmt`, `cargo clippy`, `cargo test`, `npm run lint`, `npm test` must all succeed.
5. **Fill out the PR template** completely.
6. **Request review** from at least one core maintainer.
7. **Squash commits** before merging if the branch has noisy history.

### Review Criteria

- Code correctness and security (especially for cryptographic code)
- Test coverage
- Documentation for public APIs
- No regressions in existing tests
- Consistent code style

---

## Issue Reporting

### Bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md). Include:

- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Solana version, Rust version, Node version)
- Transaction signatures or error logs if applicable

### Feature Requests

Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md). Include:

- Clear description of the proposed feature
- Motivation and use case
- Any relevant technical considerations

### Security Vulnerabilities

**Do not open public issues for security vulnerabilities.** Follow the [security policy](./SECURITY.md) instead.

---

## License

By contributing to KIRITE, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
<!-- updated --> #2
