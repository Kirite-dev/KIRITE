#!/usr/bin/env bash
#
# KIRITE Protocol — Solana Deployment Script
#
# Usage:
#   ./scripts/deploy.sh [devnet|testnet|mainnet-beta]
#
# Environment variables:
#   ANCHOR_WALLET     — Path to deployer keypair (default: ~/.config/solana/id.json)
#   ANCHOR_PROVIDER   — Override RPC URL
#   PROGRAM_KEYPAIR   — Path to program keypair for deterministic address
#   SKIP_BUILD        — Set to "1" to skip anchor build step
#   DRY_RUN           — Set to "1" to simulate without deploying

set -euo pipefail

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

PROGRAM_NAME="kirite"
EXPECTED_PROGRAM_ID="57yf6giJCEnjhFt7sLA3sN5GLkaZvaAfWchdvcrkcUCH"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# --------------------------------------------------------------------------- #
# Helper functions
# --------------------------------------------------------------------------- #

log_info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

die() { log_error "$*"; exit 1; }

require_cmd() {
    command -v "$1" &>/dev/null || die "'$1' is not installed. Please install it first."
}

# --------------------------------------------------------------------------- #
# Pre-flight checks
# --------------------------------------------------------------------------- #

require_cmd solana
require_cmd anchor
require_cmd jq

CLUSTER="${1:-devnet}"

case "$CLUSTER" in
    devnet|testnet|mainnet-beta) ;;
    *) die "Invalid cluster: $CLUSTER. Must be devnet, testnet, or mainnet-beta." ;;
esac

WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
if [[ ! -f "$WALLET" ]]; then
    die "Wallet keypair not found at $WALLET"
fi

DEPLOYER=$(solana-keygen pubkey "$WALLET" 2>/dev/null) || die "Failed to read deployer pubkey from $WALLET"

log_info "Deployment target: $CLUSTER"
log_info "Deployer wallet:   $DEPLOYER"

# --------------------------------------------------------------------------- #
# Cluster-specific RPC
# --------------------------------------------------------------------------- #

if [[ -n "${ANCHOR_PROVIDER:-}" ]]; then
    RPC_URL="$ANCHOR_PROVIDER"
else
    case "$CLUSTER" in
        devnet)       RPC_URL="https://api.devnet.solana.com" ;;
        testnet)      RPC_URL="https://api.testnet.solana.com" ;;
        mainnet-beta) RPC_URL="https://api.mainnet-beta.solana.com" ;;
    esac
fi

log_info "RPC endpoint:      $RPC_URL"

# Set solana CLI config for this session
solana config set --url "$RPC_URL" --keypair "$WALLET" &>/dev/null

# --------------------------------------------------------------------------- #
# Balance check
# --------------------------------------------------------------------------- #

BALANCE=$(solana balance --url "$RPC_URL" "$DEPLOYER" 2>/dev/null | awk '{print $1}')
log_info "Deployer balance:  ${BALANCE} SOL"

MIN_BALANCE="3"
if (( $(echo "$BALANCE < $MIN_BALANCE" | bc -l 2>/dev/null || echo 1) )); then
    log_warn "Balance may be insufficient for deployment (recommended >= ${MIN_BALANCE} SOL)"
    if [[ "$CLUSTER" == "mainnet-beta" ]]; then
        die "Refusing to deploy to mainnet with low balance. Fund the deployer wallet first."
    fi
fi

# --------------------------------------------------------------------------- #
# Mainnet safety gate
# --------------------------------------------------------------------------- #

if [[ "$CLUSTER" == "mainnet-beta" ]]; then
    echo ""
    echo -e "${RED}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║  WARNING: You are about to deploy to MAINNET-BETA          ║${NC}"
    echo -e "${RED}║                                                            ║${NC}"
    echo -e "${RED}║  Deployer:  ${DEPLOYER:0:20}...                    ║${NC}"
    echo -e "${RED}║  Balance:   ${BALANCE} SOL                                  ║${NC}"
    echo -e "${RED}║                                                            ║${NC}"
    echo -e "${RED}║  This action is IRREVERSIBLE for the initial deployment.   ║${NC}"
    echo -e "${RED}╚══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    read -rp "Type 'DEPLOY-MAINNET' to confirm: " CONFIRM
    if [[ "$CONFIRM" != "DEPLOY-MAINNET" ]]; then
        die "Mainnet deployment cancelled."
    fi

    # Additional mainnet checks
    log_info "Running mainnet pre-deployment checklist..."

    # Verify upgrade authority is set correctly
    if [[ -z "${PROGRAM_KEYPAIR:-}" ]]; then
        log_warn "No PROGRAM_KEYPAIR specified — Anchor will generate a new program address."
        read -rp "Continue without deterministic program address? (yes/no): " CONT
        [[ "$CONT" == "yes" ]] || die "Aborted."
    fi
fi

# --------------------------------------------------------------------------- #
# Build
# --------------------------------------------------------------------------- #

if [[ "${SKIP_BUILD:-0}" == "1" ]]; then
    log_warn "Skipping build step (SKIP_BUILD=1)"
else
    log_info "Building program..."
    anchor build --program-name "$PROGRAM_NAME" 2>&1 | tail -5

    # Verify the built program exists
    SO_FILE="target/deploy/${PROGRAM_NAME}.so"
    if [[ ! -f "$SO_FILE" ]]; then
        die "Build artifact not found: $SO_FILE"
    fi

    SO_SIZE=$(stat -f%z "$SO_FILE" 2>/dev/null || stat -c%s "$SO_FILE" 2>/dev/null)
    log_ok "Build successful — ${PROGRAM_NAME}.so (${SO_SIZE} bytes)"

    # Verify program keypair matches expected ID
    BUILT_ID=$(solana-keygen pubkey "target/deploy/${PROGRAM_NAME}-keypair.json" 2>/dev/null || echo "UNKNOWN")
    log_info "Built program ID:  $BUILT_ID"

    if [[ "$BUILT_ID" != "$EXPECTED_PROGRAM_ID" && "$EXPECTED_PROGRAM_ID" != *"1111111111"* ]]; then
        log_warn "Program ID mismatch! Expected $EXPECTED_PROGRAM_ID, got $BUILT_ID"
    fi
fi

# --------------------------------------------------------------------------- #
# Dry run exit
# --------------------------------------------------------------------------- #

if [[ "${DRY_RUN:-0}" == "1" ]]; then
    log_warn "Dry run mode — skipping actual deployment."
    log_info "Would deploy $PROGRAM_NAME to $CLUSTER"
    exit 0
fi

# --------------------------------------------------------------------------- #
# Deploy
# --------------------------------------------------------------------------- #

log_info "Deploying $PROGRAM_NAME to $CLUSTER..."

DEPLOY_ARGS=(
    --provider.cluster "$CLUSTER"
    --provider.wallet "$WALLET"
    --program-name "$PROGRAM_NAME"
)

if [[ -n "${PROGRAM_KEYPAIR:-}" ]]; then
    DEPLOY_ARGS+=(--program-keypair "$PROGRAM_KEYPAIR")
fi

DEPLOY_OUTPUT=$(anchor deploy "${DEPLOY_ARGS[@]}" 2>&1) || {
    echo "$DEPLOY_OUTPUT"
    die "Deployment failed. See output above."
}

echo "$DEPLOY_OUTPUT"

# --------------------------------------------------------------------------- #
# Post-deploy verification
# --------------------------------------------------------------------------- #

log_info "Verifying deployment..."

PROGRAM_ID=$(solana-keygen pubkey "target/deploy/${PROGRAM_NAME}-keypair.json" 2>/dev/null)

ACCOUNT_INFO=$(solana program show "$PROGRAM_ID" --url "$RPC_URL" --output json 2>/dev/null) || {
    die "Failed to fetch program account info for $PROGRAM_ID"
}

PROGRAM_SLOT=$(echo "$ACCOUNT_INFO" | jq -r '.lastDeploySlot // .slot // "unknown"' 2>/dev/null || echo "unknown")
PROGRAM_AUTH=$(echo "$ACCOUNT_INFO" | jq -r '.authority // "unknown"' 2>/dev/null || echo "unknown")

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  DEPLOYMENT SUCCESSFUL                                     ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC}  Cluster:      ${CYAN}${CLUSTER}${NC}"
echo -e "${GREEN}║${NC}  Program ID:   ${CYAN}${PROGRAM_ID}${NC}"
echo -e "${GREEN}║${NC}  Deploy Slot:  ${CYAN}${PROGRAM_SLOT}${NC}"
echo -e "${GREEN}║${NC}  Authority:    ${CYAN}${PROGRAM_AUTH}${NC}"
echo -e "${GREEN}║${NC}  Deployer:     ${CYAN}${DEPLOYER}${NC}"
echo -e "${GREEN}║${NC}  Timestamp:    ${CYAN}$(date -u '+%Y-%m-%d %H:%M:%S UTC')${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Save deployment receipt
RECEIPT_DIR="deployments/${CLUSTER}"
mkdir -p "$RECEIPT_DIR"
RECEIPT_FILE="${RECEIPT_DIR}/deploy-$(date -u '+%Y%m%d-%H%M%S').json"

cat > "$RECEIPT_FILE" <<EOF
{
  "program": "$PROGRAM_NAME",
  "programId": "$PROGRAM_ID",
  "cluster": "$CLUSTER",
  "deployer": "$DEPLOYER",
  "authority": "$PROGRAM_AUTH",
  "slot": "$PROGRAM_SLOT",
  "rpcUrl": "$RPC_URL",
  "timestamp": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "buildArtifact": "$SO_FILE",
  "walletPath": "$WALLET"
}
EOF

log_ok "Deployment receipt saved to $RECEIPT_FILE"

# --------------------------------------------------------------------------- #
# Next steps
# --------------------------------------------------------------------------- #

echo ""
log_info "Next steps:"
echo "  1. Run  ./scripts/verify.sh $CLUSTER  to verify deployment health"
echo "  2. Run  npx ts-node scripts/migrate.ts --cluster $CLUSTER  to initialize protocol"
echo "  3. Run  ./scripts/idl-publish.sh $CLUSTER  to publish IDL on-chain"
echo ""
