# Design Document — SorobanPay

## Overview

SorobanPay is a non-custodial recurring payments protocol on Stellar's Soroban smart contract platform. It enables subscription billing, creator monetization, and recurring donations without transferring custody of subscriber funds to any intermediary.

The protocol is structured as three collaborating layers:

1. **Smart Contract Layer** — A Rust/Soroban contract (`SubscriptionProtocol`) that owns subscription state, enforces time-locks, executes SEP-41 token transfers, and emits structured events.
2. **Frontend Layer** — A Next.js 14 (App Router) TypeScript application that integrates the Freighter wallet, constructs Soroban transactions, and provides subscription management UI.
3. **Build & Deployment Layer** — A GNU Makefile and `deploy.sh` shell script that automate WASM compilation, optimization, and Stellar CLI deployment.

Key design principles:

- **Non-custodial**: The contract never holds token balances. All transfers go directly from subscriber to merchant via pre-approved SEP-41 allowances.
- **Per-invocation auth**: Every entry point requires a fresh cryptographic signature from the appropriate party; no stored sessions or delegated keys.
- **Atomic state transitions**: Validation, storage mutation, token transfer, and event emission happen in a single Soroban invocation with no observable intermediate state.
- **Bounded intervals**: Payment intervals are constrained to [86400, 31536000] seconds (1 day to 365 days) to prevent spam and unreasonably long dormancy.

---

## Architecture

### Three-Layer Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                       Browser (User)                            │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   Frontend Layer                          │  │
│  │                                                           │  │
│  │  ┌──────────────────┐   ┌───────────────────────────────┐│  │
│  │  │  Wallet_Manager  │   │      Subscription_Form        ││  │
│  │  │                  │   │                               ││  │
│  │  │  - detectFreighter│  │  - merchant address field     ││  │
│  │  │  - requestAccess │   │  - token address field        ││  │
│  │  │  - storePublicKey│   │  - amount field               ││  │
│  │  │  - disconnect    │   │  - interval field (default    ││  │
│  │  └────────┬─────────┘   │    2592000s)                  ││  │
│  │           │             └──────────────┬────────────────┘│  │
│  │           │                            │                  │  │
│  │           ▼                            ▼                  │  │
│  │  ┌──────────────────────────────────────────────────────┐ │  │
│  │  │               Transaction_Builder                    │ │  │
│  │  │                                                      │ │  │
│  │  │  - buildSubscribeTx(params)                          │ │  │
│  │  │  - signTransaction(xdr, networkPassphrase)           │ │  │
│  │  │  - submitAndPoll(signedXdr, timeout=60s)             │ │  │
│  │  └───────────────────────┬──────────────────────────────┘ │  │
│  └──────────────────────────│───────────────────────────────┘  │
│                             │ Freighter Extension               │
│                             ▼                                   │
│                    ┌─────────────────┐                          │
│                    │ Stellar RPC     │                          │
│                    │ (Soroban RPC)   │                          │
│                    └────────┬────────┘                          │
└─────────────────────────────│───────────────────────────────────┘
                              │
              ┌───────────────▼──────────────────┐
              │         Smart Contract Layer      │
              │                                  │
              │  ┌────────────────────────────┐  │
              │  │   SubscriptionProtocol     │  │
              │  │   (soroban_sdk contract)   │  │
              │  │                            │  │
              │  │  Entry points:             │  │
              │  │  - subscribe(...)          │  │
              │  │  - execute_payment(...)    │  │
              │  │  - cancel(...)             │  │
              │  │                            │  │
              │  │  Internal components:      │  │
              │  │  - Validator               │  │
              │  │  - Storage Manager         │  │
              │  │  - Event Emitter           │  │
              │  └────────────────────────────┘  │
              │                                  │
              │  Persistent Storage              │
              │  DataKey::Subscription(sub,mer)  │
              │  → SubscriptionData              │
              └───────────────┬──────────────────┘
                              │
              ┌───────────────▼──────────────────┐
              │    SEP-41 Token Contract(s)       │
              │   (SAC or custom token)           │
              └──────────────────────────────────┘
```

### Build & Deployment Layer

```
┌────────────────────────────────────────────────────────┐
│              Build & Deployment Layer                  │
│                                                        │
│  Makefile                deploy.sh                     │
│  ┌────────────────┐      ┌─────────────────────────┐   │
│  │  build target  │─────▶│ 1. make build            │   │
│  │  test target   │      │ 2. stellar contract      │   │
│  │  clean target  │      │    deploy --wasm ...     │   │
│  └────────────────┘      │ 3. write CONTRACT_ID     │   │
│                          │    to stdout             │   │
│  cargo build             └─────────────────────────┘   │
│  --target wasm32-unknown-unknown                        │
│  --release                                             │
│                                                        │
│  Output: contracts/target/wasm32-unknown-unknown/      │
│          release/soroban_subscription_contract.wasm    │
└────────────────────────────────────────────────────────┘
```

### Data Flow: Subscription Creation

```
Subscriber Browser
      │
      │  1. Fill form (merchant, token, amount, interval)
      │  2. Click "Subscribe"
      ▼
Subscription_Form (React)
      │
      │  3. Client-side validation
      ▼
Transaction_Builder
      │
      │  4. buildSubscribeTx() → assembleTransaction(op)
      │  5. signTransaction(xdr) → Freighter popup
      ▼
Freighter Extension
      │
      │  6. User approves → returns signedXdr
      ▼
Transaction_Builder
      │
      │  7. submitAndPoll(signedXdr) → Stellar Soroban RPC
      ▼
Stellar Soroban RPC
      │
      │  8. Soroban invocation
      ▼
SubscriptionProtocol::subscribe(subscriber, merchant, token, amount, interval)
      │
      │  9.  subscriber.require_auth()
      │  10. Validator::validate_amount(amount)
      │  11. Validator::validate_interval(interval)
      │  12. storage().persistent().set(DataKey::Subscription(...), data)
      │  13. storage().persistent().extend_ttl(..., MAX_TTL_LEDGERS)
      │  14. env.events().publish((symbol("subscribe"), subscriber, merchant), amount)
      ▼
Soroban RPC → returns tx hash + result
      │
      ▼
Frontend: displays success notification
```

---

## Components and Interfaces

### Smart Contract Components

#### SubscriptionProtocol Contract

The top-level contract struct exposed via `#[contract]`. Contains no stored fields of its own; all state lives in persistent storage.

```rust
#[contract]
pub struct SubscriptionProtocol;

#[contractimpl]
impl SubscriptionProtocol {
    pub fn subscribe(
        env: Env,
        subscriber: Address,
        merchant: Address,
        token: Address,
        amount: i128,
        interval: u64,
    ) -> Result<(), ContractError>;

    pub fn execute_payment(
        env: Env,
        subscriber: Address,
        merchant: Address,
    ) -> Result<(), ContractError>;

    pub fn cancel(
        env: Env,
        subscriber: Address,
        merchant: Address,
    ) -> Result<(), ContractError>;
}
```

#### Validator (internal module)

Stateless functions called at the start of each entry point before any storage access.

```rust
mod validator {
    pub fn validate_amount(amount: i128) -> Result<(), ContractError>;
    pub fn validate_interval(interval: u64) -> Result<(), ContractError>;
    pub fn require_subscription(
        env: &Env,
        key: &DataKey,
    ) -> Result<SubscriptionData, ContractError>;
    pub fn require_payment_due(
        env: &Env,
        data: &SubscriptionData,
    ) -> Result<(), ContractError>;
}
```

#### Event Emitter (internal module)

```rust
mod events {
    pub fn emit_subscribe(env: &Env, subscriber: &Address, merchant: &Address, amount: i128);
    pub fn emit_executed(env: &Env, subscriber: &Address, merchant: &Address, amount: i128);
}
```

### Frontend Components

#### Wallet_Manager (React context + hooks)

```typescript
interface WalletState {
  publicKey: string | null;
  isConnected: boolean;
}

interface WalletManagerAPI {
  connect(): Promise<void>;      // calls Freighter requestAccess
  disconnect(): void;            // clears publicKey from state
  state: WalletState;
}

// Hook
function useWallet(): WalletManagerAPI;
```

#### Transaction_Builder (utility module)

```typescript
interface SubscribeParams {
  subscriber: string;   // G-address (public key)
  merchant: string;     // G-address
  token: string;        // C-address (contract)
  amount: bigint;       // positive integer
  interval: number;     // seconds, [86400, 31536000]
}

async function buildAndSubmitSubscribe(
  params: SubscribeParams,
  contractId: string,
  networkPassphrase: string,
  rpcUrl: string
): Promise<string>; // returns tx hash
```

#### Subscription_Form (React component)

```typescript
interface SubscriptionFormProps {
  contractId: string;
}

// Form fields: merchantAddress, tokenAddress, amount, interval
// Default interval: 2592000 (30 days)
// Emits inline validation errors before calling Transaction_Builder
```

---

## Data Models

### SubscriptionData (on-chain struct)

```rust
#[contracttype]
#[derive(Clone, Debug)]
pub struct SubscriptionData {
    pub token: Address,       // SEP-41 token contract address
    pub amount: i128,         // payment amount per interval (strictly positive)
    pub interval: u64,        // seconds between payments [86400, 31536000]
    pub next_payment: u64,    // Unix timestamp (seconds) of next valid payment
}
```

All fields are stored in Soroban persistent storage and are serialized using XDR via `contracttype`.

### DataKey (storage key enum)

```rust
#[contracttype]
pub enum DataKey {
    Subscription(Address, Address),  // (subscriber, merchant)
}
```

The composite key `DataKey::Subscription(subscriber, merchant)` uniquely identifies each subscription. This means a subscriber can have at most one active subscription to any given merchant at a time; re-subscribing overwrites the existing record.

### ContractError (error type)

```rust
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ContractError {
    AmountMustBePositive    = 1,
    IntervalTooShort        = 2,
    IntervalTooLong         = 3,
    NoActiveSubscription    = 4,
    PaymentNotDue           = 5,
    Unauthorized            = 6,
}
```

Error values are stable u32 constants, safe to return across contract invocation boundaries.

### TTL Constants

```rust
/// ~30 days at 5-second ledger close time
const MIN_TTL_LEDGERS: u32 = 30 * 24 * 60 * 60 / 5;    // 518_400

/// ~365 days at 5-second ledger close time
const MAX_TTL_LEDGERS: u32 = 365 * 24 * 60 * 60 / 5;   // 6_307_200
```

---

## Storage Design

### Persistent Storage Schema

| Key | Value | Notes |
|-----|-------|-------|
| `DataKey::Subscription(subscriber, merchant)` | `SubscriptionData` | One entry per (sub, mer) pair |

Only persistent storage is used for `SubscriptionData`. Instance storage and temporary storage are not used for protocol state.

### TTL Lifecycle

```
subscribe() or execute_payment() succeeds
          │
          ▼
  extend_ttl(key, MIN_TTL_LEDGERS, MAX_TTL_LEDGERS)
          │
          │  TTL is bumped to MAX_TTL_LEDGERS (~365 days)
          │  if current TTL < MIN_TTL_LEDGERS (~30 days)
          ▼
  Entry lives for up to 365 days without further interaction.
  Each successful payment resets the 365-day clock.

cancel() succeeds
          │
          ▼
  storage().persistent().remove(key)
          │
          ▼
  Entry is permanently gone.
  Subsequent reads return None.
```

### extend_ttl Call Pattern

```rust
env.storage()
    .persistent()
    .extend_ttl(&key, MIN_TTL_LEDGERS, MAX_TTL_LEDGERS);
```

The `extend_ttl` call is placed **after** the `set` call and **before** the event emission in `subscribe` and `execute_payment`. This ensures the TTL is extended only when the storage mutation was successful.

---

## Event Design

### Event: `subscribe`

Emitted by `subscribe()` upon successful state storage.

| Field | Value |
|-------|-------|
| Topic 0 | `symbol!("subscribe")` |
| Topic 1 | `subscriber: Address` |
| Topic 2 | `merchant: Address` |
| Data | `amount: i128` |

### Event: `executed`

Emitted by `execute_payment()` upon successful token transfer and state update.

| Field | Value |
|-------|-------|
| Topic 0 | `symbol!("executed")` |
| Topic 1 | `subscriber: Address` |
| Topic 2 | `merchant: Address` |
| Data | `amount: i128` |

### Event Emission Code Pattern

```rust
// After all state mutations and transfers have completed:
env.events().publish(
    (Symbol::new(&env, "subscribe"), subscriber.clone(), merchant.clone()),
    amount,
);
```

Events are published as the **last** operation before the function returns `Ok(())`. If any prior step panics or returns `Err`, the invocation reverts and no event is recorded on-chain.

### No Event on Cancel

`cancel()` emits no events, as specified in Requirement 7.5. Off-chain indexers should detect subscription removal by monitoring for the absence of future `executed` events.

---

## Frontend Architecture

### Next.js App Router Layout

```
frontend/
├── app/
│   ├── layout.tsx              # Root layout, WalletProvider context
│   ├── page.tsx                # Home page: wallet connect + subscription form
│   └── globals.css
├── components/
│   ├── Subscription_Form.tsx   # Main form component
│   ├── WalletButton.tsx        # Connect/disconnect button
│   └── NotificationBanner.tsx  # Success / error toasts
├── lib/
│   ├── wallet_manager.ts       # Freighter integration
│   ├── transaction_builder.ts  # Soroban tx construction + submission
│   └── validation.ts           # Client-side input validation
├── context/
│   └── WalletContext.tsx       # React context for wallet state
├── hooks/
│   └── useWallet.ts            # Hook consuming WalletContext
└── constants/
    └── network.ts              # RPC URLs, network passphrases, contract ID
```

### Wallet_Manager Module

```typescript
// lib/wallet_manager.ts

import {
  isConnected,
  requestAccess,
  getPublicKey,
  signTransaction,
} from "@stellar/freighter-api";

export async function detectFreighter(): Promise<boolean> {
  return await isConnected();
}

export async function connectWallet(): Promise<string> {
  // Throws if user denies access
  await requestAccess();
  return await getPublicKey();
}

export async function signTx(
  xdr: string,
  networkPassphrase: string
): Promise<string> {
  const result = await signTransaction(xdr, { networkPassphrase });
  if (result.error) throw new Error(result.error);
  return result.signedTxXdr;
}
```

### Transaction_Builder Utility

```typescript
// lib/transaction_builder.ts

import {
  Contract,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  nativeToScVal,
  Address,
} from "@stellar/stellar-sdk";
import { SorobanRpc } from "@stellar/stellar-sdk";

const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 60; // 60 seconds timeout

export async function buildAndSubmitSubscribe(
  params: SubscribeParams,
  contractId: string,
  publicKey: string,
  networkPassphrase: string,
  rpcUrl: string
): Promise<string> {
  const server = new SorobanRpc.Server(rpcUrl);
  const account = await server.getAccount(publicKey);
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      contract.call(
        "subscribe",
        new Address(params.subscriber).toScVal(),
        new Address(params.merchant).toScVal(),
        new Address(params.token).toScVal(),
        nativeToScVal(params.amount, { type: "i128" }),
        nativeToScVal(params.interval, { type: "u64" })
      )
    )
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  const signed = await signTx(prepared.toXDR(), networkPassphrase);

  const sendResult = await server.sendTransaction(
    TransactionBuilder.fromXDR(signed, networkPassphrase)
  );

  return await pollForConfirmation(server, sendResult.hash);
}

async function pollForConfirmation(
  server: SorobanRpc.Server,
  hash: string
): Promise<string> {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const result = await server.getTransaction(hash);
    if (result.status === "SUCCESS") return hash;
    if (result.status === "FAILED") throw new Error(result.resultMetaXdr ?? "Transaction failed");
  }
  throw new Error("Transaction confirmation timeout after 60 seconds");
}
```

### State Management

Wallet state is held in a React Context (`WalletContext`) to avoid prop drilling.

```typescript
interface WalletContextValue {
  publicKey: string | null;      // null = disconnected
  connect: () => Promise<void>;
  disconnect: () => void;
}

const WalletContext = createContext<WalletContextValue>(...);
```

Subscription form state is local to `Subscription_Form` using `useState`. There is no global subscription state; the frontend reads contract data on demand via Soroban RPC view calls.

```typescript
// Subscription_Form local state
const [isSubmitting, setIsSubmitting] = useState(false);
const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
const [successData, setSuccessData] = useState<SuccessData | null>(null);
const [txError, setTxError] = useState<string | null>(null);

// isSubmitting controls both the disabled button AND the loading indicator
// Both clear together when submission resolves (success or error)
```

---

## Transaction Flows

### Sequence: Subscription Creation

```
Subscriber          Subscription_Form   Transaction_Builder    Freighter       Soroban RPC     Contract
    │                      │                    │                  │               │               │
    │ 1. Fill form          │                    │                  │               │               │
    │──────────────────────▶│                    │                  │               │               │
    │                       │                    │                  │               │               │
    │ 2. Submit             │                    │                  │               │               │
    │──────────────────────▶│                    │                  │               │               │
    │                       │                    │                  │               │               │
    │                       │ 3. Validate inputs │                  │               │               │
    │                       │◀───────────────────│ (client-side)    │               │               │
    │                       │                    │                  │               │               │
    │                       │ 4. buildSubscribeTx│                  │               │               │
    │                       │───────────────────▶│                  │               │               │
    │                       │                    │ 5. getAccount    │               │               │
    │                       │                    │──────────────────────────────────▶               │
    │                       │                    │ 6. account info  │               │               │
    │                       │                    │◀──────────────────────────────────               │
    │                       │                    │ 7. prepareTransaction            │               │
    │                       │                    │──────────────────────────────────▶               │
    │                       │                    │ 8. prepared XDR  │               │               │
    │                       │                    │◀──────────────────────────────────               │
    │                       │                    │ 9. signTx(xdr)   │               │               │
    │                       │                    │─────────────────▶│               │               │
    │ 10. Freighter popup   │                    │                  │               │               │
    │◀──────────────────────────────────────────────────────────────│               │               │
    │ 11. Approve           │                    │                  │               │               │
    │──────────────────────────────────────────────────────────────▶│               │               │
    │                       │                    │ 12. signedXdr    │               │               │
    │                       │                    │◀─────────────────│               │               │
    │                       │                    │ 13. sendTransaction              │               │
    │                       │                    │──────────────────────────────────▶               │
    │                       │                    │                  │               │ 14. invoke    │
    │                       │                    │                  │               │───────────────▶
    │                       │                    │                  │               │               │
    │                       │                    │                  │               │ 15. subscribe()
    │                       │                    │                  │               │  (auth, validate,
    │                       │                    │                  │               │   store, ttl, event)
    │                       │                    │                  │               │◀──────────────│
    │                       │                    │ 16. poll(hash)   │               │               │
    │                       │                    │──────────────────────────────────▶               │
    │                       │                    │ 17. SUCCESS      │               │               │
    │                       │                    │◀──────────────────────────────────               │
    │                       │ 18. success data   │                  │               │               │
    │                       │◀───────────────────│                  │               │               │
    │ 19. Success notification                   │                  │               │               │
    │◀──────────────────────│                    │                  │               │               │
```

### Sequence: Payment Execution

```
Merchant        execute_payment()
    │                  │
    │ 1. invoke        │
    │─────────────────▶│
    │                  │  2. merchant.require_auth()
    │                  │  3. load DataKey::Subscription(sub, mer)
    │                  │     → Some(data) or NoActiveSubscription error
    │                  │  4. check now >= data.next_payment
    │                  │     → or PaymentNotDue error
    │                  │  5. token.transfer(subscriber, merchant, amount)
    │                  │     → or propagate token error (state unchanged)
    │                  │  6. data.next_payment = now + data.interval
    │                  │  7. storage().persistent().set(key, data)
    │                  │  8. storage().persistent().extend_ttl(key, MIN, MAX)
    │                  │  9. events.publish(("executed", sub, mer), amount)
    │                  │  10. return Ok(())
    │◀─────────────────│
```

### Sequence: Cancellation

```
Subscriber       cancel()
    │               │
    │ 1. invoke     │
    │──────────────▶│
    │               │  2. subscriber.require_auth()
    │               │  3. load DataKey::Subscription(sub, mer)
    │               │     → Some(data) or NoActiveSubscription error
    │               │  4. storage().persistent().remove(key)
    │               │  5. return Ok(())  [no event emitted]
    │◀──────────────│
```

---

## Build System Design

### Makefile Targets

```makefile
CONTRACT_DIR := contracts/subscription
TARGET_DIR   := contracts/target
WASM_PATH    := $(TARGET_DIR)/wasm32-unknown-unknown/release/soroban_subscription_contract.wasm

.PHONY: build test clean

build:
	cargo build \
	    --manifest-path $(CONTRACT_DIR)/Cargo.toml \
	    --target wasm32-unknown-unknown \
	    --release
	@test -f $(WASM_PATH) || (echo "ERROR: WASM artifact not found at $(WASM_PATH)" >&2; exit 1)

test:
	cargo test \
	    --manifest-path $(CONTRACT_DIR)/Cargo.toml

clean:
	cargo clean --manifest-path $(CONTRACT_DIR)/Cargo.toml
```

### WASM Compilation Pipeline

```
contracts/subscription/
├── Cargo.toml          # [profile.release] opt-level = "z", overflow-checks = true
├── src/
│   ├── lib.rs          # contract entry point + #[cfg(test)]
│   ├── error.rs        # ContractError enum
│   ├── storage.rs      # DataKey, SubscriptionData, TTL helpers
│   ├── validator.rs    # Validator functions
│   └── events.rs       # emit_subscribe, emit_executed
```

**Cargo.toml release profile**:
```toml
[profile.release]
opt-level = "z"         # optimize for binary size
overflow-checks = true  # keep arithmetic safety in release
lto = true
codegen-units = 1
```

The `soroban-sdk` feature flags:
```toml
[dependencies]
soroban-sdk = { version = "20.0.0", features = [] }

[dev-dependencies]
soroban-sdk = { version = "20.0.0", features = ["testutils"] }
proptest = { version = "1.0", default-features = false, features = ["alloc"] }
proptest-derive = "0.4"
```

---

## Deployment Design

### deploy.sh Script Flow

```
deploy.sh
    │
    │  1. Read STELLAR_NETWORK env var
    │     - default: "testnet"
    │     - "mainnet": use mainnet RPC
    │     - any other value: stderr + exit 1
    │
    │  2. Set RPC_URL and NETWORK_PASSPHRASE
    │     - testnet:  https://soroban-testnet.stellar.org
    │                 "Test SDF Network ; September 2015"
    │     - mainnet:  https://mainnet.stellar.validationcloud.io/v1/...
    │                 "Public Global Stellar Network ; September 2015"
    │
    │  3. make build
    │     - on non-zero exit: stderr "Build failed." + exit 1
    │
    │  4. stellar contract deploy \
    │       --wasm contracts/target/wasm32-unknown-unknown/release/soroban_subscription_contract.wasm \
    │       --source alice \
    │       --rpc-url $RPC_URL \
    │       --network-passphrase "$NETWORK_PASSPHRASE"
    │     - on non-zero exit: stderr message + exit 1
    │
    │  5. capture CONTRACT_ID from stellar CLI stdout
    │
    │  6. echo "$CONTRACT_ID"   ← only line on stdout
    │     exit 0
```

### Environment Variables

| Variable | Values | Default |
|----------|--------|---------|
| `STELLAR_NETWORK` | `testnet`, `mainnet` | `testnet` |
| `STELLAR_IDENTITY` | identity alias for `stellar` CLI | `alice` |

### deploy.sh Skeleton

```bash
#!/usr/bin/env bash
set -euo pipefail

NETWORK="${STELLAR_NETWORK:-testnet}"
IDENTITY="${STELLAR_IDENTITY:-alice}"

case "$NETWORK" in
  testnet)
    RPC_URL="https://soroban-testnet.stellar.org"
    PASSPHRASE="Test SDF Network ; September 2015"
    ;;
  mainnet)
    RPC_URL="https://horizon.stellar.org"
    PASSPHRASE="Public Global Stellar Network ; September 2015"
    ;;
  *)
    echo "ERROR: Unknown STELLAR_NETWORK value: '$NETWORK'. Use 'testnet' or 'mainnet'." >&2
    exit 1
    ;;
esac

# Step 1: Build
if ! make build; then
  echo "ERROR: Contract build failed." >&2
  exit 1
fi

WASM="contracts/target/wasm32-unknown-unknown/release/soroban_subscription_contract.wasm"

# Step 2: Deploy
CONTRACT_ID=$(stellar contract deploy \
  --wasm "$WASM" \
  --source "$IDENTITY" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$PASSPHRASE" 2>/dev/null) || {
    echo "ERROR: Contract deployment failed." >&2
    exit 1
  }

echo "$CONTRACT_ID"
```

---

## Test Architecture

### Unit Tests (example-based)

Located in `contracts/subscription/src/lib.rs` under `#[cfg(test)]`, using `soroban-sdk` testutils.

**Standard test setup pattern**:
```rust
#[cfg(test)]
mod tests {
    use soroban_sdk::{
        testutils::{Address as _, AuthorizedFunction, Ledger, LedgerInfo},
        Env, Address,
    };
    use crate::{SubscriptionProtocol, SubscriptionProtocolClient, ContractError};

    fn setup() -> (Env, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let subscriber = Address::generate(&env);
        let merchant = Address::generate(&env);
        let token = env.register_stellar_asset_contract(subscriber.clone());
        (env, subscriber, merchant, token)
    }
}
```

**Key example tests**:

| Test | Scenario |
|------|----------|
| `test_full_lifecycle` | subscribe → advance clock → execute_payment → cancel |
| `test_payment_not_due_after_subscribe` | subscribe → execute_payment immediately → expect error |
| `test_execute_after_cancel` | subscribe → cancel → execute_payment → "no active subscription" |
| `test_subscribe_amount_zero` | subscribe(amount=0) → error, no storage |
| `test_subscribe_interval_too_short` | subscribe(interval=86399) → error, no storage |
| `test_subscribe_interval_too_long` | subscribe(interval=31536001) → error, no storage |
| `test_auth_required_subscribe` | subscribe without subscriber auth → panic/error |
| `test_auth_required_execute_payment` | execute_payment without merchant auth → panic/error |
| `test_auth_required_cancel` | cancel without subscriber auth → panic/error |
| `test_subscribe_emits_event` | subscribe → check events list |
| `test_execute_payment_emits_event` | execute_payment → check events list |
| `test_cancel_no_event` | cancel → check events list is empty |
| `test_no_events_on_invalid_subscribe` | subscribe(amount=0) → check events list empty |
| `test_subscribe_overwrites_existing` | subscribe twice → second params are stored |

### Integration Test: Full Lifecycle

```rust
#[test]
fn test_full_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();
    
    // Setup token with initial balances
    let token_admin = Address::generate(&env);
    let subscriber = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token = env.register_stellar_asset_contract(token_admin.clone());
    let token_client = token::Client::new(&env, &token);
    token_client.mint(&subscriber, &1_000_000_i128);
    
    // Deploy contract
    let contract_id = env.register_contract(None, SubscriptionProtocol);
    let client = SubscriptionProtocolClient::new(&env, &contract_id);
    
    // Allow contract to spend on subscriber's behalf
    token_client.approve(&subscriber, &contract_id, &500_000_i128, &200_u32);
    
    let amount: i128 = 100_000;
    let interval: u64 = 86_400;
    
    // (a) subscribe
    client.subscribe(&subscriber, &merchant, &token, &amount, &interval);
    let data = env.storage().persistent()
        .get::<DataKey, SubscriptionData>(&DataKey::Subscription(subscriber.clone(), merchant.clone()))
        .unwrap();
    assert_eq!(data.amount, amount);
    assert_eq!(data.interval, interval);
    assert_eq!(data.next_payment, env.ledger().timestamp() + interval);
    
    // (b) advance clock past next_payment
    env.ledger().set(LedgerInfo {
        timestamp: env.ledger().timestamp() + interval + 1,
        ..Default::default()
    });
    
    let subscriber_balance_before = token_client.balance(&subscriber);
    let merchant_balance_before = token_client.balance(&merchant);
    
    // (c) execute_payment
    client.execute_payment(&subscriber, &merchant);
    assert_eq!(token_client.balance(&subscriber), subscriber_balance_before - amount);
    assert_eq!(token_client.balance(&merchant), merchant_balance_before + amount);
    
    // (d) cancel
    client.cancel(&subscriber, &merchant);
    assert!(env.storage().persistent()
        .get::<DataKey, SubscriptionData>(&DataKey::Subscription(subscriber.clone(), merchant.clone()))
        .is_none());
}
```

### Property-Based Tests

Using `proptest` crate with Soroban testutils (no-std compatible via `features = ["alloc"]`).

```rust
use proptest::prelude::*;

proptest! {
    // Property: Time-lock enforcement — execute_payment immediately after subscribe always errors
    #[test]
    fn prop_execute_before_due_always_errors(
        amount in 1_i128..=1_000_000_i128,
        interval in 86_400_u64..=31_536_000_u64,
    ) {
        // Feature: soroban-pay, Property 3: Time-lock enforcement
        let env = Env::default();
        env.mock_all_auths();
        // ... setup, subscribe, immediately call execute_payment ...
        // Assert: execute_payment returns Err(ContractError::PaymentNotDue)
        // Assert: subscriber balance unchanged
    }

    // Property: Subscription round-trip — stored fields exactly match inputs
    #[test]
    fn prop_subscribe_round_trip(
        amount in 1_i128..=1_000_000_i128,
        interval in 86_400_u64..=31_536_000_u64,
    ) {
        // Feature: soroban-pay, Property 1: Subscription data round-trip
        // Assert: stored.amount == amount, stored.interval == interval
        // Assert: stored.next_payment == ledger_ts + interval
    }

    // Property: next_payment precision — always equals ledger_ts_at_subscribe + interval
    #[test]
    fn prop_next_payment_equals_ts_plus_interval(
        amount in 1_i128..=1_000_000_i128,
        interval in 86_400_u64..=31_536_000_u64,
    ) {
        // Feature: soroban-pay, Property 2: next_payment computation
        // Assert: stored.next_payment == env.ledger().timestamp() + interval
    }

    // Property: Double-payment prevention — second execute_payment without clock advance errors
    #[test]
    fn prop_double_payment_prevention(
        amount in 1_i128..=1_000_000_i128,
        interval in 86_400_u64..=31_536_000_u64,
    ) {
        // Feature: soroban-pay, Property 4: Idempotence / double-payment prevention
        // subscribe → advance clock → execute_payment (success) → execute_payment again
        // Assert: second call returns PaymentNotDue
        // Assert: subscriber balance reflects exactly one deduction
    }

    // Property: Amount validation — all amounts <= 0 are rejected
    #[test]
    fn prop_non_positive_amount_rejected(
        amount in i128::MIN..=0_i128,
        interval in 86_400_u64..=31_536_000_u64,
    ) {
        // Feature: soroban-pay, Property 5: Amount validation
        // Assert: subscribe returns Err(ContractError::AmountMustBePositive)
        // Assert: no storage entry created
    }

    // Property: Interval validation — all intervals < 86400 are rejected
    #[test]
    fn prop_short_interval_rejected(
        amount in 1_i128..=1_000_000_i128,
        interval in 0_u64..86_400_u64,
    ) {
        // Feature: soroban-pay, Property 6: Interval lower-bound validation
        // Assert: subscribe returns Err(ContractError::IntervalTooShort)
        // Assert: no storage entry created
    }

    // Property: Interval validation — all intervals > 31536000 are rejected
    #[test]
    fn prop_long_interval_rejected(
        amount in 1_i128..=1_000_000_i128,
        interval in 31_536_001_u64..=u64::MAX,
    ) {
        // Feature: soroban-pay, Property 7: Interval upper-bound validation
        // Assert: subscribe returns Err(ContractError::IntervalTooLong)
        // Assert: no storage entry created
    }

    // Property: Cancel prevents future payments for any valid subscription
    #[test]
    fn prop_cancel_prevents_future_payments(
        amount in 1_i128..=1_000_000_i128,
        interval in 86_400_u64..=31_536_000_u64,
    ) {
        // Feature: soroban-pay, Property 8: Cancel terminates subscription
        // subscribe → cancel → execute_payment
        // Assert: execute_payment returns Err(ContractError::NoActiveSubscription)
    }
}
```

### Test Coverage Matrix

| Requirement | Unit Tests | Property Tests |
|-------------|-----------|----------------|
| 1: Subscribe | lifecycle, overwrite, events | round-trip, amount/interval validation |
| 2: Execute Payment | lifecycle, not-due, insufficient funds | time-lock, double-payment, balance |
| 3: Cancel | lifecycle, no event, cancel-then-execute | cancel-then-execute |
| 4: Non-custodial | balance invariant | balance correctness |
| 5: Time-lock | not-due after subscribe | next_payment precision |
| 6: TTL | ttl after subscribe, ttl after payment | — |
| 7: Events | event content, no event on failure | — |
| 8: Validation | each error case | all validation boundaries |
| 13: Test suite | all explicit test requirements | all explicit PBT requirements |

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

The following properties are derived from the acceptance criteria analysis. Each is universally quantified and implementable as a property-based test using `proptest` with Soroban testutils.

### Property 1: Subscription Data Round-Trip

*For any* valid `(token, amount, interval)` tuple where `amount > 0` and `86400 ≤ interval ≤ 31536000`, calling `subscribe(subscriber, merchant, token, amount, interval)` and then reading the stored `SubscriptionData` SHALL produce a record where `stored.token == token`, `stored.amount == amount`, `stored.interval == interval`, and `stored.next_payment == ledger_timestamp_at_subscribe + interval`.

**Validates: Requirements 1.5, 5.1, 13.8, 13.9**

---

### Property 2: Time-Lock Enforcement — Immediate Payment Rejection

*For any* valid `(amount, interval)` pair where `amount > 0` and `86400 ≤ interval ≤ 31536000`, calling `execute_payment` immediately after `subscribe` (without advancing the ledger clock) SHALL return `ContractError::PaymentNotDue` and the subscriber's token balance SHALL remain unchanged.

**Validates: Requirements 2.3, 5.2, 13.6**

---

### Property 3: Double-Payment Prevention

*For any* valid subscription where `amount > 0` and `86400 ≤ interval ≤ 31536000`, after one successful `execute_payment` (with clock advanced past `next_payment`), a second `execute_payment` called without further advancing the clock SHALL return `ContractError::PaymentNotDue` and the subscriber's token balance SHALL reflect exactly one deduction (decreased by exactly `amount`).

**Validates: Requirements 5.3, 5.4, 13.7**

---

### Property 4: Amount Validation — Non-Positive Rejection

*For any* `amount ≤ 0` and any valid `interval` in `[86400, 31536000]`, calling `subscribe` SHALL return `ContractError::AmountMustBePositive` and no `SubscriptionData` entry SHALL be created or modified in persistent storage, and no event SHALL be emitted.

**Validates: Requirements 1.2, 8.1, 13.4**

---

### Property 5: Interval Lower-Bound Validation

*For any* `interval < 86400` (in `[0, 86399]`) and any valid `amount > 0`, calling `subscribe` SHALL return `ContractError::IntervalTooShort` and no `SubscriptionData` entry SHALL be created or modified in persistent storage, and no event SHALL be emitted.

**Validates: Requirements 1.3, 8.2, 13.5**

---

### Property 6: Interval Upper-Bound Validation

*For any* `interval > 31536000` and any valid `amount > 0`, calling `subscribe` SHALL return `ContractError::IntervalTooLong` and no `SubscriptionData` entry SHALL be created or modified in persistent storage, and no event SHALL be emitted.

**Validates: Requirements 1.4, 8.2**

---

### Property 7: Cancellation Terminates Subscription

*For any* active subscription (valid `amount`, `interval`), calling `cancel` followed by `execute_payment` SHALL result in `execute_payment` returning `ContractError::NoActiveSubscription`, regardless of the current ledger timestamp.

**Validates: Requirements 3.3, 3.5, 8.5**

---

### Property 8: Subscribe Event Correctness

*For any* valid `subscribe` invocation with `amount > 0` and `86400 ≤ interval ≤ 31536000`, the Soroban event stream SHALL contain exactly one event with topics `(symbol("subscribe"), subscriber, merchant)` and data equal to the `amount` argument — no more, no less.

**Validates: Requirements 1.8, 7.1, 7.6, 13.10**

---

### Property 9: Executed Event Correctness

*For any* valid `execute_payment` invocation where `Ledger_Timestamp ≥ next_payment`, the Soroban event stream SHALL contain exactly one event with topics `(symbol("executed"), subscriber, merchant)` and data equal to the `amount` stored in `SubscriptionData` — no more, no less.

**Validates: Requirements 2.7, 7.2, 7.6, 13.10**

---

### Property 10: No Events on Validation Failure

*For any* `subscribe` call with `amount ≤ 0` or `interval < 86400`, and *for any* `execute_payment` call before `next_payment` has elapsed or on a cancelled subscription, the Soroban event stream SHALL be empty (no events emitted).

**Validates: Requirements 7.4, 13.11**

---

### Property 11: Balance Invariant — Correct Transfer Amount

*For any* successful `execute_payment` call, the subscriber's token balance SHALL decrease by exactly `amount` and the merchant's token balance SHALL increase by exactly `amount`. The contract's own token balance SHALL be zero both before and after the invocation.

**Validates: Requirements 4.1, 4.2, 4.3**

---

## Error Handling

### Contract Error Strategy

All errors are returned as `Result<(), ContractError>`. The Soroban SDK converts these to contract errors that the Stellar RPC surfaces to callers. Soroban reverts all state changes on any error — there is no partial state.

| Error | Code | Trigger | State Effect |
|-------|------|---------|-------------|
| `AmountMustBePositive` | 1 | `amount <= 0` in `subscribe` | No change |
| `IntervalTooShort` | 2 | `interval < 86400` in `subscribe` | No change |
| `IntervalTooLong` | 3 | `interval > 31536000` in `subscribe` | No change |
| `NoActiveSubscription` | 4 | No storage entry in `execute_payment` or `cancel` | No change |
| `PaymentNotDue` | 5 | `now < next_payment` in `execute_payment` | No change |
| `Unauthorized` | 6 | `require_auth()` failure | No change (panic) |

Auth failures (`require_auth()`) result in a panic/trap from the SDK rather than a returned error code; callers observe a contract invocation failure with an auth error.

Token transfer errors (insufficient allowance, insufficient balance) are propagated as-is from the token contract. The `SubscriptionData` record is not modified when a token transfer fails because the storage mutation happens **after** the transfer call in `execute_payment`.

### Frontend Error Handling

```typescript
try {
  const hash = await buildAndSubmitSubscribe(params, ...);
  setSuccessData({ hash, ...params });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("rejected")) {
    setTxError("Transaction rejected by user.");
  } else if (message.includes("timeout")) {
    setTxError("Transaction timed out. Please retry.");
  } else {
    setTxError(message);
  }
} finally {
  setIsSubmitting(false);  // always clears both button and loading indicator
}
```

---

## Security Considerations

### Per-Invocation Authorization Model

Every entry point calls `subscriber.require_auth()` or `merchant.require_auth()` as its first operation before reading any storage or executing any logic. Soroban's `require_auth()` verifies a valid cryptographic signature from the address's key is present in the current transaction's authorization envelope. There is no session state, no cookie, and no delegated credential mechanism.

**Design decision**: Using `require_auth()` rather than checking `env.invoker()` ensures that contract-to-contract calls also respect the authorization model. A calling contract cannot impersonate a subscriber without the subscriber's explicit authorization.

### Allowance Model (Non-Custodial)

Subscribers grant a SEP-41 `approve(spender: contract_id, amount: allowance)` to the protocol contract. The contract never calls `token.transfer_from` with itself as custodian — it calls `token.transfer(subscriber, merchant, amount)` which requires the subscriber to have authorized the transfer.

This means:
- The protocol contract holds zero token balance at all times (Property 11).
- A compromised merchant key can only trigger payments for subscriptions where `now >= next_payment` — it cannot steal the full allowance in one call.
- Subscribers can revoke their allowance at any time by calling `token.approve(contract_id, 0)`, which prevents any future `execute_payment` regardless of on-chain subscription state.

### No Custody Guarantees

The protocol does not guarantee that a merchant will trigger payment exactly on schedule. `execute_payment` is permissionless once `next_payment` has elapsed — any party could call it on behalf of the merchant. The protocol guarantees that payment cannot happen *before* `next_payment` (time-lock), but it does not auto-trigger payments.

### Storage TTL and Subscription Expiry

Subscriptions expire from on-chain storage if `execute_payment` is not called for approximately 365 days. An expired (TTL=0) entry behaves identically to a cancelled entry: `execute_payment` returns `NoActiveSubscription`. To reactivate, a new `subscribe` call is required.

### Input Sanitization

Address types in Soroban are validated by the SDK at the XDR decode boundary — passing a malformed address will fail before the contract even executes. Amount and interval validation is performed by the Validator before any state access.

---

## Testing Strategy

### Property-Based Testing Library

**Crate**: `proptest` v1.x with `default-features = false, features = ["alloc"]` for no-std compatibility with Soroban WASM targets. Tests run in native (`x86_64`) via `cargo test`, not in WASM.

**Configuration**: Each `proptest!` macro block defaults to 100 iterations. For interval boundary properties, the strategy range is set to explore both valid and invalid boundaries.

### Dual Testing Approach

**Property tests** (using `proptest!`):
- Verify universal correctness invariants across the entire valid input space.
- Minimum 100 iterations per property (proptest default).
- Tagged with: `// Feature: soroban-pay, Property N: <property_text>`

**Unit tests** (using standard `#[test]`):
- Verify specific scenarios, error paths, event content, auth behavior.
- Cover each explicit test case in Requirement 13.

**Integration tests** (Soroban testutils, full lifecycle):
- Requirement 13.1 full lifecycle test runs the complete state machine end-to-end.
- Token mint, allowance approval, subscribe, advance clock, execute_payment, cancel — all in a single test.

### Test File Organization

```
contracts/subscription/src/
├── lib.rs
│   └── #[cfg(test)] mod tests {
│       ├── unit tests (test_*)
│       └── proptest! blocks (prop_*)
│   }
```

All tests are in the same crate to access private module internals and to use `Env::default()` with `mock_all_auths()`.

### Frontend Testing

- **Unit**: Jest + React Testing Library for `Subscription_Form`, `Wallet_Manager`, form validation.
- **Property tests**: Not applicable to UI layer (rendering and state machine behavior is tested with examples and snapshots).
- **Integration**: Mock Freighter API and Stellar RPC using `jest.mock`.
