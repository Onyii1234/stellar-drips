# Implementation Plan: SorobanPay

## Overview

SorobanPay is a non-custodial recurring payments protocol on Stellar's Soroban smart contract platform. Implementation proceeds in four layers: (1) Rust/Soroban smart contract with all entry points, storage, errors, and events; (2) build and deployment tooling (Makefile + deploy.sh); (3) Next.js 14 TypeScript frontend with Freighter wallet integration; and (4) documentation. Each layer builds on the previous, and property-based tests are placed immediately after the code they verify to catch regressions early.

---

## Tasks

- [x] 1. Scaffold smart contract crate
  - [x] 1.1 Create `contracts/subscription/` directory structure
    - Create `contracts/subscription/src/` directory
    - Write `contracts/subscription/Cargo.toml` with `soroban-sdk = "20.0.0"` dependency (no features on `[dependencies]`, `testutils` + `proptest = { version = "1.0", default-features = false, features = ["alloc"] }` + `proptest-derive = "0.4"` on `[dev-dependencies]`)
    - Add `[profile.release]` block: `opt-level = "z"`, `overflow-checks = true`, `lto = true`, `codegen-units = 1`
    - Add `[lib]` section with `crate-type = ["cdylib", "rlib"]`
    - Create empty `contracts/subscription/src/lib.rs` stub (`#![no_std]` + `soroban_sdk::contractimpl` placeholder)
    - _Requirements: 11.1, 11.3_

- [x] 2. Implement contract data layer
  - [x] 2.1 Implement `contracts/subscription/src/storage.rs`
    - Define `DataKey` enum: `#[contracttype] pub enum DataKey { Subscription(Address, Address) }`
    - Define `SubscriptionData` struct: `#[contracttype] #[derive(Clone, Debug)] pub struct SubscriptionData { pub token: Address, pub amount: i128, pub interval: u64, pub next_payment: u64 }`
    - Define TTL constants: `MIN_TTL_LEDGERS: u32 = 30 * 24 * 60 * 60 / 5` (518400), `MAX_TTL_LEDGERS: u32 = 365 * 24 * 60 * 60 / 5` (6307200)
    - _Requirements: 6.1, 6.3, 6.4_

  - [x] 2.2 Implement `contracts/subscription/src/error.rs`
    - Define `ContractError` enum with `#[contracterror]`, `#[repr(u32)]`, `Copy + Clone + Debug + Eq + PartialEq`
    - Assign stable codes: `AmountMustBePositive = 1`, `IntervalTooShort = 2`, `IntervalTooLong = 3`, `NoActiveSubscription = 4`, `PaymentNotDue = 5`, `Unauthorized = 6`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 3. Implement contract logic modules
  - [x] 3.1 Implement `contracts/subscription/src/events.rs`
    - Implement `pub fn emit_subscribe(env: &Env, subscriber: &Address, merchant: &Address, amount: i128)` — publishes with topics `(symbol!("subscribe"), subscriber.clone(), merchant.clone())` and data `amount`
    - Implement `pub fn emit_executed(env: &Env, subscriber: &Address, merchant: &Address, amount: i128)` — publishes with topics `(symbol!("executed"), subscriber.clone(), merchant.clone())` and data `amount`
    - _Requirements: 7.1, 7.2, 7.6_

  - [x] 3.2 Implement `contracts/subscription/src/lib.rs` — `SubscriptionProtocol` contract
    - Declare modules: `mod storage; mod error; mod events;`
    - Define `#[contract] pub struct SubscriptionProtocol;`
    - Implement `subscribe(env, subscriber, merchant, token, amount, interval) -> Result<(), ContractError>`:
      1. `subscriber.require_auth()`
      2. Validate `amount > 0` → `ContractError::AmountMustBePositive`
      3. Validate `interval >= 86400` → `ContractError::IntervalTooShort`
      4. Validate `interval <= 31536000` → `ContractError::IntervalTooLong`
      5. Build `SubscriptionData { token, amount, interval, next_payment: env.ledger().timestamp() + interval }`
      6. `env.storage().persistent().set(&DataKey::Subscription(subscriber.clone(), merchant.clone()), &data)`
      7. `env.storage().persistent().extend_ttl(&key, MIN_TTL_LEDGERS, MAX_TTL_LEDGERS)`
      8. `events::emit_subscribe(&env, &subscriber, &merchant, amount)`
      9. Return `Ok(())`
    - Implement `execute_payment(env, subscriber, merchant) -> Result<(), ContractError>`:
      1. `merchant.require_auth()`
      2. Load `SubscriptionData` or return `ContractError::NoActiveSubscription`
      3. Check `env.ledger().timestamp() >= data.next_payment` or return `ContractError::PaymentNotDue`
      4. Call SEP-41 `token::Client::new(&env, &data.token).transfer(&subscriber, &merchant, &data.amount)`
      5. Update `data.next_payment = env.ledger().timestamp() + data.interval`
      6. `env.storage().persistent().set(&key, &data)`
      7. `env.storage().persistent().extend_ttl(&key, MIN_TTL_LEDGERS, MAX_TTL_LEDGERS)`
      8. `events::emit_executed(&env, &subscriber, &merchant, data.amount)`
      9. Return `Ok(())`
    - Implement `cancel(env, subscriber, merchant) -> Result<(), ContractError>`:
      1. `subscriber.require_auth()`
      2. Check entry exists or return `ContractError::NoActiveSubscription`
      3. `env.storage().persistent().remove(&key)`
      4. Return `Ok(())` (no event)
    - _Requirements: 1.1–1.8, 2.1–2.9, 3.1–3.5, 4.1–4.6, 5.1–5.6, 6.1–6.7, 7.1–7.6, 8.1–8.7_

- [x] 4. Checkpoint — verify contract compiles
  - Ensure all tests pass, ask the user if questions arise.
  - Run `cargo build --target wasm32-unknown-unknown --release` from `contracts/subscription/` and confirm the WASM artifact is produced at `contracts/target/wasm32-unknown-unknown/release/soroban_subscription_contract.wasm`.

- [x] 5. Implement contract test suite
  - [x] 5.1 Implement unit tests in `contracts/subscription/src/lib.rs` under `#[cfg(test)]`
    - Add `use soroban_sdk::{testutils::{Address as _, Ledger, LedgerInfo}, Env, Address};`
    - Implement `setup()` helper: `Env::default()`, `env.mock_all_auths()`, generate subscriber/merchant/token addresses, register stellar asset contract, mint tokens, approve allowance
    - Implement `test_full_lifecycle`: subscribe → assert storage fields → advance clock → execute_payment → assert balance delta → cancel → assert entry gone (Req 13.1)
    - Implement `test_payment_not_due_after_subscribe`: subscribe → execute_payment immediately → assert `ContractError::PaymentNotDue`, assert balance unchanged (Req 13.2)
    - Implement `test_execute_after_cancel`: subscribe → cancel → execute_payment → assert `ContractError::NoActiveSubscription`, no transfer (Req 13.3)
    - Implement `test_subscribe_amount_zero`: subscribe(amount=0) → assert error, assert no storage entry (Req 13.4)
    - Implement `test_subscribe_interval_too_short`: subscribe(interval=86399) → assert `ContractError::IntervalTooShort`, assert no storage entry (Req 13.5)
    - Implement `test_subscribe_interval_too_long`: subscribe(interval=31536001) → assert `ContractError::IntervalTooLong`, assert no storage entry
    - Implement `test_auth_required_subscribe`, `test_auth_required_execute_payment`, `test_auth_required_cancel` (without `mock_all_auths`)
    - Implement `test_subscribe_emits_event`, `test_execute_payment_emits_event`, `test_cancel_no_event`, `test_no_events_on_invalid_subscribe` (Req 13.10, 13.11)
    - Implement `test_subscribe_overwrites_existing`: subscribe twice with different params → assert second set of fields stored
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_

  - [x]* 5.2 Write property test — Property 1: Subscription data round-trip
    - Add `use proptest::prelude::*;` and `proptest!` block
    - `prop_subscribe_round_trip(amount in 1_i128..=1_000_000_i128, interval in 86_400_u64..=31_536_000_u64)`: subscribe, read stored SubscriptionData, assert `stored.amount == amount`, `stored.interval == interval`, `stored.next_payment == ledger_ts + interval`, `stored.token == token`
    - **Property 1: Subscription Data Round-Trip**
    - **Validates: Requirements 1.5, 5.1, 13.8, 13.9**

  - [x]* 5.3 Write property test — Property 2: Time-lock enforcement (immediate rejection)
    - `prop_execute_before_due_always_errors(amount in 1_i128..=1_000_000_i128, interval in 86_400_u64..=31_536_000_u64)`: subscribe, immediately execute_payment, assert `ContractError::PaymentNotDue`, assert subscriber balance unchanged
    - **Property 2: Time-Lock Enforcement — Immediate Payment Rejection**
    - **Validates: Requirements 2.3, 5.2, 13.6**

  - [x]* 5.4 Write property test — Property 3: Double-payment prevention
    - `prop_double_payment_prevention(amount in 1_i128..=1_000_000_i128, interval in 86_400_u64..=31_536_000_u64)`: subscribe → advance clock → execute_payment (success) → execute_payment again (no clock advance) → assert `ContractError::PaymentNotDue`, assert balance reflects exactly one deduction
    - **Property 3: Double-Payment Prevention**
    - **Validates: Requirements 5.3, 5.4, 13.7**

  - [x]* 5.5 Write property test — Property 4: Amount validation (non-positive rejection)
    - `prop_non_positive_amount_rejected(amount in i128::MIN..=0_i128, interval in 86_400_u64..=31_536_000_u64)`: subscribe(amount), assert `ContractError::AmountMustBePositive`, assert no storage entry created, assert no events emitted
    - **Property 4: Amount Validation — Non-Positive Rejection**
    - **Validates: Requirements 1.2, 8.1, 13.4**

  - [x]* 5.6 Write property test — Property 5: Interval lower-bound validation
    - `prop_short_interval_rejected(amount in 1_i128..=1_000_000_i128, interval in 0_u64..86_400_u64)`: subscribe(interval), assert `ContractError::IntervalTooShort`, assert no storage entry, assert no events
    - **Property 5: Interval Lower-Bound Validation**
    - **Validates: Requirements 1.3, 8.2, 13.5**

  - [x]* 5.7 Write property test — Property 6: Interval upper-bound validation
    - `prop_long_interval_rejected(amount in 1_i128..=1_000_000_i128, interval in 31_536_001_u64..=u64::MAX)`: subscribe(interval), assert `ContractError::IntervalTooLong`, assert no storage entry, assert no events
    - **Property 6: Interval Upper-Bound Validation**
    - **Validates: Requirements 1.4, 8.2**

  - [x]* 5.8 Write property test — Property 7: Cancellation terminates subscription
    - `prop_cancel_prevents_future_payments(amount in 1_i128..=1_000_000_i128, interval in 86_400_u64..=31_536_000_u64)`: subscribe → cancel → advance clock past next_payment → execute_payment → assert `ContractError::NoActiveSubscription`
    - **Property 7: Cancellation Terminates Subscription**
    - **Validates: Requirements 3.3, 3.5, 8.5**

  - [x]* 5.9 Write property test — Property 8 & 9: Event correctness
    - `prop_subscribe_event_correct(amount, interval)`: subscribe → assert exactly one `subscribe` event with matching topics and data
    - `prop_execute_event_correct(amount, interval)`: subscribe → advance clock → execute_payment → assert exactly one `executed` event with matching topics and data
    - **Properties 8 & 9: Subscribe and Executed Event Correctness**
    - **Validates: Requirements 1.8, 2.7, 7.1, 7.2, 7.6, 13.10**

  - [x]* 5.10 Write property test — Property 10 & 11: No events on failure + balance invariant
    - `prop_no_events_on_validation_failure(amount in i128::MIN..=0_i128, interval in 86_400_u64..=31_536_000_u64)`: subscribe(invalid) → assert events list empty
    - `prop_balance_invariant(amount, interval)`: subscribe → advance clock → execute_payment → assert subscriber balance decreased by exactly `amount`, merchant increased by exactly `amount`, contract balance == 0
    - **Properties 10 & 11: No Events on Failure + Balance Invariant**
    - **Validates: Requirements 4.1, 4.2, 4.3, 7.4, 13.11**

- [x] 6. Checkpoint — verify full test suite passes
  - Ensure all tests pass, ask the user if questions arise.
  - Run `cargo test --manifest-path contracts/subscription/Cargo.toml` and confirm zero failures, zero errors, zero panics.

- [x] 7. Implement build and deployment tooling
  - [x] 7.1 Implement `Makefile` at project root
    - Define `CONTRACT_DIR := contracts/subscription`, `TARGET_DIR := contracts/target`, `WASM_PATH := $(TARGET_DIR)/wasm32-unknown-unknown/release/soroban_subscription_contract.wasm`
    - Implement `build` target: `cargo build --manifest-path $(CONTRACT_DIR)/Cargo.toml --target wasm32-unknown-unknown --release`, then assert WASM file exists (emit error to stderr + exit 1 if missing)
    - Implement `test` target: `cargo test --manifest-path $(CONTRACT_DIR)/Cargo.toml`
    - Implement `clean` target: `cargo clean --manifest-path $(CONTRACT_DIR)/Cargo.toml`
    - Mark all three as `.PHONY`
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

  - [x] 7.2 Implement `deploy/deploy.sh`
    - Add shebang `#!/usr/bin/env bash` and `set -euo pipefail`
    - Read `STELLAR_NETWORK` (default `testnet`), `STELLAR_IDENTITY` (default `alice`)
    - `case` on `$NETWORK`: `testnet` → set `RPC_URL` and `PASSPHRASE` for testnet; `mainnet` → set for mainnet; `*` → write error to stderr, exit 1
    - Call `make build`; on non-zero exit write "ERROR: Contract build failed." to stderr, exit 1
    - Run `stellar contract deploy --wasm "$WASM" --source "$IDENTITY" --rpc-url "$RPC_URL" --network-passphrase "$PASSPHRASE"`, capture stdout as `CONTRACT_ID`; on failure write error to stderr, exit 1
    - `echo "$CONTRACT_ID"` (only stdout line), exit 0
    - Make executable (`chmod +x`)
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

- [x] 8. Scaffold Next.js frontend
  - [x] 8.1 Create `frontend/` Next.js 14 App Router project
    - Scaffold with TypeScript, Tailwind CSS, and App Router enabled
    - Add dependencies: `@stellar/stellar-sdk` (latest), `@stellar/freighter-api` (latest)
    - Create directory structure: `frontend/app/`, `frontend/components/`, `frontend/lib/`, `frontend/context/`, `frontend/hooks/`, `frontend/constants/`
    - Create `frontend/constants/network.ts` exporting `RPC_URL`, `NETWORK_PASSPHRASE`, `CONTRACT_ID` (reads from `process.env` with fallback defaults for testnet)
    - _Requirements: 9.1, 10.1_

- [x] 9. Implement frontend library modules
  - [x] 9.1 Implement `frontend/lib/wallet_manager.ts`
    - Import `isConnected`, `requestAccess`, `getPublicKey`, `signTransaction` from `@stellar/freighter-api`
    - Implement `detectFreighter(): Promise<boolean>` — returns `isConnected()`
    - Implement `connectWallet(): Promise<string>` — calls `requestAccess()`, then `getPublicKey()`, throws on denial
    - Implement `signTx(xdr: string, networkPassphrase: string): Promise<string>` — calls `signTransaction(xdr, { networkPassphrase })`, throws if `result.error` is present, returns `result.signedTxXdr`
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 9.2 Implement `frontend/lib/validation.ts`
    - Implement `isValidGAddress(addr: string): boolean` — validates Stellar G-address format (56-char base32, starts with G)
    - Implement `isValidCAddress(addr: string): boolean` — validates Stellar C-address format (contract address)
    - Implement `validateSubscriptionForm(fields): FieldErrors` — returns map of field → error string for: invalid merchant address, invalid token address, amount ≤ 0, interval outside [86400, 31536000]
    - Export `FieldErrors` interface
    - _Requirements: 10.1, 10.9_

  - [x] 9.3 Implement `frontend/lib/transaction_builder.ts`
    - Import `Contract, TransactionBuilder, BASE_FEE, nativeToScVal, Address` from `@stellar/stellar-sdk` and `SorobanRpc`
    - Define `SubscribeParams` interface: `{ subscriber: string, merchant: string, token: string, amount: bigint, interval: number }`
    - Implement `buildAndSubmitSubscribe(params, contractId, publicKey, networkPassphrase, rpcUrl): Promise<string>`:
      1. `new SorobanRpc.Server(rpcUrl)` → `server.getAccount(publicKey)`
      2. Build tx with `new Contract(contractId).call("subscribe", ...)` using `nativeToScVal` for i128/u64
      3. `server.prepareTransaction(tx)`
      4. `signTx(prepared.toXDR(), networkPassphrase)` (from wallet_manager)
      5. `server.sendTransaction(...)` → `pollForConfirmation(server, hash)`
    - Implement `pollForConfirmation(server, hash): Promise<string>` — polls up to 60 attempts (1s interval), throws on FAILED or timeout
    - _Requirements: 10.2, 10.3, 10.4, 10.6_

- [x] 10. Implement frontend React context and hooks
  - [x] 10.1 Implement `frontend/context/WalletContext.tsx`
    - Define `WalletContextValue` interface: `{ publicKey: string | null, connect: () => Promise<void>, disconnect: () => void }`
    - Create `WalletContext` with `createContext`
    - Implement `WalletProvider` component: holds `publicKey` state, calls `connectWallet()` on connect (handles denial by catching and setting error), clears state on disconnect
    - On connect: show install-Freighter message with extension store link if `detectFreighter()` returns false (Req 9.1)
    - Export `WalletProvider` and `WalletContext`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [x] 10.2 Implement `frontend/hooks/useWallet.ts`
    - Implement `useWallet(): WalletContextValue` — consumes `WalletContext`, throws if used outside `WalletProvider`
    - _Requirements: 9.5, 9.6_

- [x] 11. Implement frontend UI components
  - [x] 11.1 Implement `frontend/components/SubscriptionForm.tsx`
    - Define form fields: `merchantAddress`, `tokenAddress`, `amount`, `interval` (default value: `2592000`)
    - Hold local state: `isSubmitting`, `fieldErrors: FieldErrors`, `successData`, `txError`
    - On submit: call `validateSubscriptionForm(fields)` — if errors, set `fieldErrors`, do NOT call Transaction_Builder (Req 10.9)
    - On valid submit: set `isSubmitting = true` (disables button + shows spinner), call `buildAndSubmitSubscribe(...)`, on success set `successData` with merchant, amount, token, interval (Req 10.5), on error classify and set `txError` (Req 10.6), in `finally` set `isSubmitting = false`
    - Render inline validation errors below each field
    - Render success notification with merchant address, amount, token, interval
    - Render error notification with retry option (form data preserved)
    - Render loading spinner while `isSubmitting`
    - Accept `contractId: string` prop
    - _Requirements: 10.1, 10.2, 10.5, 10.6, 10.7, 10.8, 10.9_

  - [x] 11.2 Implement `frontend/app/layout.tsx` and `frontend/app/page.tsx`
    - `layout.tsx`: root layout wrapping children in `<WalletProvider>`, import global CSS, set metadata title "SorobanPay"
    - `page.tsx`: render wallet connect/disconnect button (shows public key when connected, enables form; shows disabled form when disconnected), render `<SubscriptionForm contractId={CONTRACT_ID} />` only when wallet connected, render Freighter install prompt when not connected
    - _Requirements: 9.1, 9.5, 9.6, 10.1_

- [x] 12. Checkpoint — verify frontend builds
  - Ensure all tests pass, ask the user if questions arise.
  - Run `npm run build` (or equivalent) from `frontend/` and confirm zero TypeScript errors and zero build failures.

- [x] 13. Write `README.md`
  - [x] 13.1 Write project-root `README.md`
    - **Prerequisites** section: Rust + `wasm32-unknown-unknown` target, Stellar CLI, Node.js 18+, Freighter browser extension
    - **Smart Contract** section: `make build`, `make test`, `make clean` commands with expected outputs
    - **Deployment** section: `STELLAR_NETWORK=testnet bash deploy/deploy.sh` usage, `STELLAR_IDENTITY` env var, sample output (contract address on stdout)
    - **Frontend Setup** section: `cd frontend && npm install && npm run dev`, env vars `NEXT_PUBLIC_CONTRACT_ID`, `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_NETWORK_PASSPHRASE`
    - **Environment Variables** table listing all required and optional vars with defaults
    - _Requirements: 11.1, 11.2, 12.1, 12.5_

- [x] 14. Final checkpoint — full project build and test
  - Ensure all tests pass, ask the user if questions arise.
  - Run `make build && make test` to confirm WASM compiles and all contract tests (unit + property) pass.
  - Run `npm run build` in `frontend/` to confirm zero TypeScript errors.

---

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP; they include property-based tests and unit test sub-tasks.
- Each task references specific requirements for traceability.
- All contract tests live under `#[cfg(test)]` in `contracts/subscription/src/lib.rs` so they can access private module internals and use `Env::default()` with `mock_all_auths()`.
- Property tests use `proptest` v1.x with `default-features = false, features = ["alloc"]` for no-std compatibility; they run in native (`x86_64`) via `cargo test`, not in WASM.
- The frontend uses React Context for wallet state and local `useState` for form state; no global subscription state is needed.
- The `deploy.sh` script requires a pre-configured Stellar CLI identity (default: `alice`); fund it on testnet via `stellar keys fund alice --network testnet` before deploying.
- `isSubmitting` state controls both the disabled button and the loading indicator simultaneously; both clear in the `finally` block of the submit handler.

---

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "2.2"] },
    { "id": 2, "tasks": ["3.1", "3.2"] },
    { "id": 3, "tasks": ["7.1", "7.2", "8.1"] },
    { "id": 4, "tasks": ["5.1", "9.1", "9.2", "9.3"] },
    { "id": 5, "tasks": ["5.2", "5.3", "5.4", "5.5", "5.6", "5.7", "5.8", "5.9", "5.10", "10.1", "10.2"] },
    { "id": 6, "tasks": ["11.1", "11.2"] },
    { "id": 7, "tasks": ["13.1"] }
  ]
}
```
