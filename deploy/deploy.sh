#!/usr/bin/env bash
# =============================================================================
# SorobanPay — Contract Deployment Script
# =============================================================================
# Usage:
#   bash deploy/deploy.sh
#   STELLAR_NETWORK=mainnet bash deploy/deploy.sh
#
# Environment variables:
#   STELLAR_NETWORK   "testnet" (default) or "mainnet"
#   STELLAR_IDENTITY  Stellar CLI identity alias (default: "alice")
#
# Output:
#   stdout — deployed contract address (and nothing else)
#   stderr — all diagnostic messages and error details
#   exit 0 — deployment succeeded
#   exit 1 — any failure (build, deploy, invalid env)
# =============================================================================
set -euo pipefail

NETWORK="${STELLAR_NETWORK:-testnet}"
IDENTITY="${STELLAR_IDENTITY:-alice}"
WASM="contracts/target/wasm32-unknown-unknown/release/soroban_subscription_contract.wasm"

# ── Network configuration ────────────────────────────────────────────────────
case "$NETWORK" in
  testnet)
    RPC_URL="https://soroban-testnet.stellar.org"
    PASSPHRASE="Test SDF Network ; September 2015"
    ;;
  mainnet)
    RPC_URL="https://mainnet.stellar.validationcloud.io/v1/xyciqR7GmMO0UHcbCwqCgjovqv9IFr-mf0xmHdGP9sI="
    PASSPHRASE="Public Global Stellar Network ; September 2015"
    ;;
  *)
    echo "ERROR: Unknown STELLAR_NETWORK value: '${NETWORK}'. Allowed values: 'testnet', 'mainnet'." >&2
    exit 1
    ;;
esac

echo "Network:  ${NETWORK}" >&2
echo "Identity: ${IDENTITY}" >&2
echo "RPC URL:  ${RPC_URL}" >&2

# ── Step 1: Build ─────────────────────────────────────────────────────────────
echo "" >&2
echo "Building contract..." >&2
if ! make build; then
  echo "ERROR: Contract build failed. See output above for details." >&2
  exit 1
fi

# Verify WASM artifact is present
if [ ! -f "$WASM" ]; then
  echo "ERROR: WASM artifact not found at '${WASM}' after build." >&2
  exit 1
fi
echo "Build successful: ${WASM}" >&2

# ── Step 2: Deploy ────────────────────────────────────────────────────────────
echo "" >&2
echo "Deploying contract to ${NETWORK}..." >&2
CONTRACT_ID=$(
  stellar contract deploy \
    --wasm "$WASM" \
    --source "$IDENTITY" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$PASSPHRASE" \
    2>/dev/null
) || {
  echo "ERROR: Contract deployment failed. Ensure the Stellar CLI is installed and '${IDENTITY}' identity is configured and funded." >&2
  exit 1
}

if [ -z "$CONTRACT_ID" ]; then
  echo "ERROR: Deployment returned an empty contract ID." >&2
  exit 1
fi

echo "Deployment successful." >&2
echo "" >&2

# ── Output: Contract address on stdout (ONLY line on stdout) ──────────────────
echo "$CONTRACT_ID"
