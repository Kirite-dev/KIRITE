# Security Policy

KIRITE is a privacy protocol that handles sensitive financial operations. Security is our highest priority.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x.x (current development) | Yes |

Only the latest release on `main` receives security patches. Older versions are not maintained.

## Reporting a Vulnerability

**Do not open public GitHub issues for security vulnerabilities.**

If you discover a security vulnerability in the KIRITE protocol, SDK, CLI, or any related component, please report it responsibly.

### Contact

Send your report to:

**security@kirite.dev**

### What to Include

- Description of the vulnerability
- Steps to reproduce (proof of concept if possible)
- Affected components (on-chain program, SDK, CLI)
- Potential impact assessment
- Suggested fix, if you have one

### Response Timeline

| Stage | Timeline |
|-------|----------|
| Acknowledgment | Within 48 hours |
| Initial assessment | Within 5 business days |
| Status update | Within 10 business days |
| Fix deployed (critical) | Within 14 days |
| Fix deployed (non-critical) | Within 30 days |

### Process

1. **Report** -- Send details to security@kirite.dev.
2. **Acknowledgment** -- We confirm receipt and assign a tracking identifier.
3. **Assessment** -- We evaluate severity, impact, and exploitability.
4. **Fix** -- We develop and test a patch internally.
5. **Disclosure** -- Once the fix is deployed, we publish a security advisory with full details and credit the reporter (unless anonymity is requested).

### Scope

The following are in scope:

- KIRITE on-chain program (Rust / Anchor)
- TypeScript SDK (`@kirite/sdk`)
- CLI tool
- Cryptographic implementations (Twisted ElGamal, commitment schemes, stealth address derivation)
- Key management and secret handling

The following are out of scope:

- Third-party dependencies (report directly to the upstream project)
- Social engineering attacks
- Denial of service via Solana network congestion (not protocol-specific)
- Issues in test/example code that is clearly marked as non-production

### Severity Classification

| Severity | Description |
|----------|-------------|
| Critical | Loss of funds, private key exposure, broken encryption |
| High | Privacy leak (amount, sender, or recipient deanonymization) |
| Medium | Partial information leakage, griefing attacks |
| Low | Minor issues with limited impact |

### Recognition

We maintain a security hall of fame for researchers who responsibly disclose valid vulnerabilities. If you would like to be credited, include your preferred name and link in your report.

## Cryptographic Audit Status

KIRITE's cryptographic primitives are under active development. A formal third-party audit is planned before mainnet deployment. The current codebase should be treated as unaudited.

## Security Best Practices for Users

- Never share deposit note commitments or nullifiers.
- Store stealth address spend keys with the same care as private keys.
- Verify you are interacting with the official KIRITE program ID before signing transactions.
- Use a hardware wallet for high-value operations when possible.
