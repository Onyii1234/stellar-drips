# Requirements Document

## Introduction

SorobanPay is a production-grade, non-custodial recurring payments protocol built on Stellar's Soroban smart contract platform. It enables the subscription economy — SaaS billing, creator subscriptions, and recurring donations — directly on-chain without requiring custodial wallets or pre-authorized transaction arrays.

The protocol is composed of three layers:

1. **Smart Contract Layer** — Rust/Soroban contracts that manage subscription state, enforce time-locks, execute token transfers, and emit indexed events.
2. **Frontend Layer** — A Next.js/TypeScript application that connects to the Freighter wallet, builds Soroban transactions, and provides a subscription management UI.
3. **Build & Deployment Layer** — Makefile and shell script tooling that compiles WASM artifacts and deploys contracts to the Stellar testnet via the Stellar CLI.

---

## Glossary

- **Subscription_Contract**: The Soroban smart contract responsible for storing subscription state, enforcing payment intervals, and executing token transfers.
- **Subscriber**: An on-chain account (Address) that authorizes and funds recurring payments.
- **Merchant**: An on-chain account (Address) that receives recurring payments.
- **SubscriptionData**: A persistent on-chain record containing the token address, payment amount, interval, and next scheduled payment timestamp.
- **Token**: A Stellar Asset Contract (SAC) or SEP-41 compatible token used as the payment denomination.
- **Allowance**: The pre-approved spending limit that the Subscriber grants to the Subscription_Contract on a given Token, enabling non-custodial transfers.
- **Interval**: The minimum time in seconds that must elapse between consecutive payments for a given subscription. The minimum valid interval is 86400 seconds (1 day). The maximum valid interval is 31536000 seconds (365 days).
- **Next_Payment**: The ledger timestamp (in seconds) at or after which the next payment execution is valid.
- **TTL (Time-To-Live)**: The number of ledgers for which a persistent storage entry remains accessible before expiry. The minimum TTL corresponds to approximately 30 days and the maximum to approximately 365 days, based on the Stellar network's ~5-second ledger close time.
- **Ledger_Timestamp**: The current time as reported by the Soroban environment's `env.ledger().timestamp()`, expressed in Unix seconds.
- **Freighter**: The official Stellar browser wallet extension used to sign and submit Soroban transactions.
- **WASM**: WebAssembly binary artifact compiled from the Rust contract source and deployed to Stellar.
- **Stellar_CLI**: The command-line tool used to deploy, invoke, and manage Soroban contracts on the Stellar network.
- **Testnet**: The Stellar test network used for non-production deployment and validation.
- **DataKey**: The composite on-chain storage key `Subscription(subscriber: Address, merchant: Address)` uniquely identifying a subscription record.
- **Validator**: The input validation logic within the Subscription_Contract that enforces preconditions before state mutation.
- **Event_Emitter**: The component within the Subscription_Contract that publishes structured events to the Soroban event stream.
- **Frontend**: The Next.js web application providing the user interface for wallet connection and subscription management.
- **Wallet_Manager**: The Frontend module responsible for connecting to Freighter, requesting account access, and managing wallet state.
- **Transaction_Builder**: The Frontend utility that constructs and submits Soroban transactions for contract invocations.
- **Subscription_Form**: The Frontend React component through which users initiate and authorize subscriptions.

---

## Requirements

### Requirement 1: Subscription Creation

**User Story:** As a Subscriber, I want to create an on-chain subscription to a Merchant, so that I authorize recurring payments without transferring custody of my funds.

#### Acceptance Criteria

1. WHEN a Subscriber invokes `subscribe(subscriber, merchant, token, amount, interval)`, THE Subscription_Contract SHALL require and verify the Subscriber's authorization signature before proceeding; IF the signature is absent or invalid, THE Subscription_Contract SHALL reject the call without modifying any state.
2. WHEN `subscribe` is invoked with an amount of 0 or less, THE Validator SHALL reject the call and return an error indicating the amount must be strictly positive, without modifying any storage, emitting any events, or invoking any Token transfers.
3. WHEN `subscribe` is invoked with an interval less than 86400 seconds, THE Validator SHALL reject the call and return an error indicating the minimum allowed interval, without modifying any storage, emitting any events, or invoking any Token transfers.
4. WHEN `subscribe` is invoked with an interval greater than 31536000 seconds (365 days), THE Validator SHALL reject the call and return an error indicating the maximum allowed interval, without modifying any storage, emitting any events, or invoking any Token transfers.
5. WHEN `subscribe` is invoked with valid inputs (amount > 0, 86400 ≤ interval ≤ 31536000, valid addresses), THE Subscription_Contract SHALL store a SubscriptionData record keyed by `DataKey::Subscription(subscriber, merchant)` containing the token address, amount, interval, and `next_payment = Ledger_Timestamp + interval`.
6. WHEN `subscribe` is invoked with valid inputs, THE Subscription_Contract SHALL call `env.storage().persistent().extend_ttl()` such that after the call the entry's TTL is extended to the maximum TTL of `365 * 24 * 60 * 60 / 5` ledgers.
7. WHEN `subscribe` is invoked for a `(subscriber, merchant)` pair that already has an active SubscriptionData record, THE Subscription_Contract SHALL overwrite the existing record with the new parameters atomically, such that no partial update is observable.
8. WHEN `subscribe` succeeds, THE Subscription_Contract SHALL emit a `subscribe` event with topics `(symbol("subscribe"), subscriber, merchant)` and data `amount` after all state mutations have completed.

---

### Requirement 2: Payment Execution

**User Story:** As a Merchant, I want to trigger payment collection at or after the scheduled time, so that I receive funds according to the agreed subscription terms.

#### Acceptance Criteria

1. WHEN a Merchant invokes `execute_payment(subscriber, merchant)`, THE Subscription_Contract SHALL require and verify the Merchant's authorization signature before proceeding; IF the signature is absent or invalid, THE Subscription_Contract SHALL reject the call without modifying any state.
2. IF no SubscriptionData exists in persistent storage for the given `(subscriber, merchant)` DataKey, THEN THE Validator SHALL reject the call and return an error indicating that no active subscription was found, without performing any Token transfer or modifying any state.
3. IF a SubscriptionData record exists but `Ledger_Timestamp < next_payment`, THEN THE Validator SHALL reject the call and return an error indicating the payment interval has not elapsed, without performing any Token transfer or modifying any state.
4. WHEN `execute_payment` is invoked and a SubscriptionData record exists for the pair AND `Ledger_Timestamp >= next_payment`, THE Subscription_Contract SHALL invoke `token.transfer(subscriber, merchant, amount)` using the Subscriber's pre-authorized Token Allowance.
5. WHEN a payment transfer is successfully executed, THE Subscription_Contract SHALL update `next_payment` to `Ledger_Timestamp + interval` on the SubscriptionData record, where `Ledger_Timestamp` is the value read at the start of the `execute_payment` invocation.
6. WHEN a payment transfer is successfully executed, THE Subscription_Contract SHALL call `env.storage().persistent().extend_ttl()` such that after the call the entry's TTL is extended to the maximum TTL of `365 * 24 * 60 * 60 / 5` ledgers.
7. WHEN a payment transfer is successfully executed, THE Event_Emitter SHALL emit an `executed` event with topics `(symbol("executed"), subscriber, merchant)` and data `amount` after all state mutations have completed.
8. IF the Token transfer fails because the Subscriber's Token Allowance is less than the subscription amount, THEN THE Subscription_Contract SHALL propagate the original token contract error to the caller, and the SubscriptionData record SHALL remain unchanged.
9. IF the Token transfer fails because the Subscriber's Token balance is insufficient, THEN THE Subscription_Contract SHALL propagate the original token contract error to the caller, and the SubscriptionData record SHALL remain unchanged.

---

### Requirement 3: Subscription Cancellation

**User Story:** As a Subscriber, I want to cancel an active subscription, so that no further payments are collected by the Merchant.

#### Acceptance Criteria

1. WHEN a Subscriber invokes `cancel(subscriber, merchant)`, THE Subscription_Contract SHALL require and verify the Subscriber's authorization signature before proceeding.
2. IF the Subscriber's authorization signature is absent or invalid, THEN THE Subscription_Contract SHALL reject the call and return an error without modifying any state.
3. WHEN `cancel` is invoked for a `(subscriber, merchant)` pair that has an active SubscriptionData record, THE Subscription_Contract SHALL remove the SubscriptionData entry from persistent storage; IF the removal operation fails unexpectedly, THE Subscription_Contract SHALL return an error to the caller and leave the SubscriptionData record in its pre-cancellation state.
4. IF `cancel` is invoked for a `(subscriber, merchant)` pair for which no SubscriptionData record exists, THEN THE Validator SHALL reject the call and return an error indicating no active subscription exists for the given pair, without modifying any state.
5. WHEN a subscription is successfully cancelled, THE Subscription_Contract SHALL ensure that any subsequent `execute_payment` call for the same `(subscriber, merchant)` pair returns the "no active subscription found" error (Requirement 2, Criterion 2) until a new subscription is created via `subscribe`.

---

### Requirement 4: Payment Authorization and Non-Custodial Model

**User Story:** As a Subscriber, I want the protocol to collect payments using my pre-approved Token Allowance, so that the contract never holds my funds in custody.

#### Acceptance Criteria

1. THE Subscription_Contract SHALL never hold a non-zero Token balance on behalf of any Subscriber or Merchant; the contract's own token balance SHALL remain zero before and after every `execute_payment` invocation.
2. WHEN `execute_payment` is invoked and all preconditions are met, THE Subscription_Contract SHALL transfer tokens directly from the Subscriber's account to the Merchant's account in a single atomic `token.transfer` call, with no intermediate custody step.
3. WHEN a Subscriber grants a Token Allowance to the Subscription_Contract, THE Subscription_Contract SHALL deduct exactly the `amount` value stored in the SubscriptionData record from the Subscriber's Allowance during each `execute_payment`, neither more nor less.
4. WHEN `execute_payment` is invoked and the Subscriber's Token Allowance for the Subscription_Contract is less than the subscription `amount`, THE Subscription_Contract SHALL reject the call and return the original token contract error, leaving the SubscriptionData record unchanged.
5. IF `execute_payment` is invoked and the Subscriber's Token balance is less than the subscription `amount`, THEN THE Subscription_Contract SHALL reject the call and return the original token contract error, leaving the SubscriptionData record unchanged.
6. THE Subscription_Contract SHALL require a valid cryptographic authorization signature from the appropriate signing party on every invocation: the Subscriber for `subscribe` and `cancel`, and the Merchant for `execute_payment`; stored session tokens or delegated credentials SHALL NOT be accepted in lieu of per-invocation signatures.

---

### Requirement 5: Time-Lock Enforcement

**User Story:** As a protocol participant, I want payment execution to be strictly gated by time, so that Merchants cannot collect payments ahead of schedule.

#### Acceptance Criteria

1. WHEN `subscribe` is invoked with valid inputs, THE Subscription_Contract SHALL set `next_payment = Ledger_Timestamp + interval` using `env.ledger().timestamp()` read at the time of the `subscribe` invocation; the resulting `next_payment` value stored on-chain SHALL equal the ledger timestamp at invocation time plus the interval exactly.
2. WHEN `execute_payment` is invoked, THE Subscription_Contract SHALL read `Ledger_Timestamp` from `env.ledger().timestamp()` and compare it against `next_payment`; IF `Ledger_Timestamp < next_payment`, THE Subscription_Contract SHALL reject the call and return an error indicating the payment interval has not elapsed, without performing any transfer.
3. WHEN `execute_payment` succeeds, THE Subscription_Contract SHALL update `next_payment` to `Ledger_Timestamp + interval` using the same `Ledger_Timestamp` read at the start of the invocation, ensuring the new `next_payment` is strictly greater than the `Ledger_Timestamp` at execution time.
4. IF `execute_payment` is invoked a second time for the same subscription without advancing the ledger clock past the updated `next_payment`, THEN THE Subscription_Contract SHALL reject the second call with the "payment interval has not elapsed" error.
5. THE Subscription_Contract SHALL enforce that the `interval` stored in SubscriptionData is always at least 86400 seconds; any `subscribe` call with an interval less than 86400 seconds SHALL be rejected (as specified in Requirement 1, Criterion 3) and SHALL NOT result in a stored interval below this minimum.
6. IF a `subscribe` call is made with an interval below 86400 seconds, THEN the stored SubscriptionData SHALL NOT be created or modified, ensuring no interval below the minimum is ever persisted.

---

### Requirement 6: Persistent Storage and TTL Management

**User Story:** As a protocol operator, I want subscription state to persist on-chain with appropriate TTL bounds, so that active subscriptions do not expire unexpectedly during normal operation.

#### Acceptance Criteria

1. THE Subscription_Contract SHALL store all SubscriptionData records using Soroban persistent storage keyed by `DataKey::Subscription(subscriber, merchant)`; no other storage tier (instance or temporary) SHALL be used for SubscriptionData.
2. WHEN a SubscriptionData entry is created or updated by `subscribe` or `execute_payment`, THE Subscription_Contract SHALL call `env.storage().persistent().extend_ttl()` with a threshold of `MIN_TTL_LEDGERS` and an extension target of `MAX_TTL_LEDGERS`; after the call, the entry's TTL SHALL be extended to `MAX_TTL_LEDGERS`.
3. THE Subscription_Contract SHALL define `MIN_TTL_LEDGERS` as `30 * 24 * 60 * 60 / 5` (518400 ledgers, approximately 30 days at 5 seconds per ledger).
4. THE Subscription_Contract SHALL define `MAX_TTL_LEDGERS` as `365 * 24 * 60 * 60 / 5` (6307200 ledgers, approximately 365 days at 5 seconds per ledger).
5. WHEN `cancel` is invoked for an existing subscription and the cancellation succeeds, THE Subscription_Contract SHALL call `env.storage().persistent().remove()` for the corresponding DataKey; after the call, a subsequent read of that DataKey SHALL return no value.
6. IF `env.storage().persistent().remove()` is invoked for a DataKey that does not exist, THE Subscription_Contract SHALL treat the operation as a no-op and not return an error from storage removal itself.
7. WHILE a SubscriptionData entry exists in persistent storage with a remaining TTL greater than 0 ledgers, THE Subscription_Contract SHALL return the full SubscriptionData value for any read of that DataKey without error.

---

### Requirement 7: Event Emission and Off-Chain Indexing

**User Story:** As an integrator, I want the contract to emit structured events for all significant state changes, so that off-chain services can index and react to subscription activity.

#### Acceptance Criteria

1. WHEN `subscribe` succeeds, THE Event_Emitter SHALL publish a Soroban contract event with topics `[symbol("subscribe"), subscriber_address, merchant_address]` and data field `amount` (i128).
2. WHEN `execute_payment` succeeds, THE Event_Emitter SHALL publish a Soroban contract event with topics `[symbol("executed"), subscriber_address, merchant_address]` and data field `amount` (i128).
3. WHEN `subscribe` or `execute_payment` succeeds, THE Event_Emitter SHALL publish the event only after all state mutations and Token transfer operations have completed successfully.
4. IF `subscribe` or `execute_payment` fails or reverts at any point, THEN THE Event_Emitter SHALL NOT publish any event for that invocation.
5. THE Subscription_Contract SHALL NOT emit any event when `cancel` is invoked, regardless of whether the cancellation succeeds or fails.
6. THE Subscription_Contract SHALL ensure that the `subscriber` and `merchant` address values in every emitted event's topics exactly match the `subscriber` and `merchant` arguments passed to the invoking entry point, with no transformation or substitution.

---

### Requirement 8: Input Validation

**User Story:** As a protocol participant, I want all contract entry points to validate inputs strictly, so that invalid or malicious calls fail early without corrupting state.

#### Acceptance Criteria

1. WHEN `subscribe` is called with `amount <= 0`, THE Validator SHALL return an error indicating the amount must be strictly positive, before reading or writing any storage, emitting any events, or invoking any Token transfers.
2. WHEN `subscribe` is called with `interval < 86400` or `interval > 31536000`, THE Validator SHALL return an error indicating the interval is outside the valid range [86400, 31536000] seconds, before reading or writing any storage, emitting any events, or invoking any Token transfers.
3. WHEN `execute_payment` is called for a subscription that does not exist (including subscriptions that have been cancelled), THE Validator SHALL return an error before performing any Token transfer or modifying any state.
4. WHEN `execute_payment` is called with `Ledger_Timestamp < next_payment`, THE Validator SHALL return an error indicating the payment interval has not elapsed, before performing any Token transfer or modifying any state.
5. WHEN `cancel` is called for a `(subscriber, merchant)` pair for which no SubscriptionData record exists, THE Validator SHALL return an error without modifying any storage.
6. WHEN any entry point is invoked, THE Subscription_Contract SHALL verify the caller's authorization by checking that the invoking account's valid cryptographic signature is present before executing any business logic; IF the authorization check fails, THE entry point SHALL return an authorization error immediately.
7. THE Subscription_Contract SHALL ensure that validation errors do not modify persistent storage, emit events, or invoke Token transfers; after any validation error, the entire on-chain state SHALL be identical to the state before the failed invocation.

---

### Requirement 9: Freighter Wallet Integration

**User Story:** As a Subscriber using the Frontend, I want to connect my Freighter wallet and authorize subscriptions, so that I can manage recurring payments from a browser interface without sharing my private keys.

#### Acceptance Criteria

1. WHEN a user visits the Frontend and the Freighter browser extension is not detected, THE Wallet_Manager SHALL display a message directing the user to install Freighter and SHALL include a direct link to the Freighter extension page in the browser extension store.
2. WHEN a user clicks the connect button and Freighter is installed, THE Wallet_Manager SHALL invoke the Freighter API's `requestAccess` method to retrieve the user's public key for the current session.
3. WHEN Freighter explicitly returns a public key in response to a `requestAccess` call initiated in the current user session, THE Wallet_Manager SHALL store that public key as the connected account address in application state and display it in the UI; public keys obtained from cached credentials or passive auto-reconnection without a current-session `requestAccess` call SHALL NOT be stored or displayed.
4. WHEN a user denies the Freighter access request, THE Wallet_Manager SHALL display an error message indicating the access was denied by the user and SHALL return to the disconnected state (identical to the state before the connect action was initiated) without crashing; UI elements not dependent on wallet connection state SHALL remain interactive.
5. WHILE a wallet is connected (a public key is stored in application state), THE Frontend SHALL display the connected account address and enable the create, view, and cancel subscription actions.
6. WHEN a user disconnects their wallet, THE Wallet_Manager SHALL clear the stored public key from application state; after the clear, the create, view, and cancel subscription actions SHALL be disabled.

---

### Requirement 10: Subscription Form and Transaction Submission

**User Story:** As a Subscriber using the Frontend, I want a form to create subscriptions and sign transactions, so that I can authorize recurring payments through a clear and guided user interface.

#### Acceptance Criteria

1. THE Subscription_Form SHALL display input fields for merchant address (Stellar G-address), token contract address (Stellar C-address), payment amount (positive integer), and payment interval (seconds).
2. WHEN a user submits the Subscription_Form with valid inputs (merchant address is a valid Stellar G-address, token address is a valid Stellar C-address, amount is a positive integer, interval is between 86400 and 31536000 seconds) and a connected wallet, THE Transaction_Builder SHALL construct a Soroban transaction invoking the `subscribe` entry point with the exact parameter values entered by the user.
3. WHEN a transaction is constructed, THE Transaction_Builder SHALL call Freighter's `signTransaction` API with the transaction XDR and the current network passphrase to request a signature from the connected account.
4. WHEN Freighter returns a signed transaction XDR, THE Transaction_Builder SHALL submit the signed transaction to the Stellar Soroban RPC endpoint and poll for confirmation for up to 60 seconds before treating the submission as a timeout failure.
5. WHEN a transaction is confirmed on-chain, THE Frontend SHALL display a success notification containing the merchant address, the payment amount, the token address, and the payment interval of the confirmed subscription.
6. IF a transaction fails during construction (invalid parameters), THE Frontend SHALL display an error message identifying the invalid field and its constraint; IF a transaction fails during signing (user rejection), THE Frontend SHALL display an error message indicating the user rejected the signature; IF a transaction fails during submission or confirmation (network or contract error), THE Frontend SHALL display the error message returned by the Stellar RPC or contract and allow the user to retry without re-entering form data.
7. WHEN the Subscription_Form is submitted, THE Frontend SHALL simultaneously disable the submit button and display a loading indicator; both the disabled state and loading indicator SHALL remain active until the transaction is confirmed or fails, and SHALL both clear at the same moment.
8. THE Subscription_Form SHALL pre-populate the interval field with a default of 2592000 seconds (30 days) when the form is first rendered.
9. WHEN the Subscription_Form is submitted with one or more invalid inputs (invalid address format, amount ≤ 0, or interval outside [86400, 31536000]), THE Frontend SHALL display inline validation errors for each invalid field and SHALL NOT call the Transaction_Builder or invoke Freighter.

---

### Requirement 11: Build System

**User Story:** As a developer, I want a reproducible build process for the Soroban contract WASM artifact, so that I can compile, test, and deploy the contract consistently across environments.

#### Acceptance Criteria

1. THE Makefile SHALL provide a `build` target that compiles the Rust contract source using `cargo build --target wasm32-unknown-unknown --release` from the `contracts/subscription` directory.
2. THE Makefile SHALL provide a `test` target that executes the contract's Soroban test suite using `cargo test` from the `contracts/subscription` directory; the target SHALL be considered successful only when all tests pass with zero failures, zero errors, and zero panics.
3. WHEN the `build` target is invoked successfully, THE Makefile SHALL produce a WASM binary at `contracts/target/wasm32-unknown-unknown/release/soroban_subscription_contract.wasm`; the target SHALL be considered successful only when that file is present after the build command exits; the binary SHALL be compiled with the `--release` profile (optimizations enabled, debug symbols excluded).
4. THE Makefile SHALL provide a `clean` target that removes all build artifacts from the `contracts/target/` directory.
5. IF the Rust toolchain (`rustc`, `cargo`) is not installed or the `wasm32-unknown-unknown` target is not added, THEN the `build` target SHALL fail with the error message produced by the Rust toolchain (e.g., "error: toolchain … is not installed" or "error[E…]: …"), rather than a silent failure with exit code 0.

---

### Requirement 12: Deployment

**User Story:** As a developer, I want an automated deployment script for the Stellar testnet, so that I can deploy the contract and configure it without manual CLI steps.

#### Acceptance Criteria

1. THE `deploy.sh` script SHALL invoke the Makefile `build` target as its first step and SHALL NOT proceed to contract deployment if the build target exits with a non-zero code.
2. WHEN the WASM artifact at `contracts/target/wasm32-unknown-unknown/release/soroban_subscription_contract.wasm` is available, THE `deploy.sh` script SHALL deploy the contract to the Stellar Testnet using the Stellar CLI `contract deploy` command with the WASM file path, source identity alias, RPC URL, and network passphrase as arguments.
3. WHEN deployment succeeds, THE `deploy.sh` script SHALL write the deployed contract address to stdout on its own line and exit with code 0; no other content SHALL be written to stdout.
4. IF any step in the script fails (build failure, Stellar CLI not installed, Testnet unreachable, deployment rejection, or any other error), THEN THE `deploy.sh` script SHALL write a descriptive error message to stderr and exit with a non-zero exit code; stdout SHALL remain empty in the failure path.
5. THE `deploy.sh` script SHALL target the Stellar Testnet by default; IF the caller sets the `STELLAR_NETWORK` environment variable to `mainnet`, THEN the script SHALL use the Stellar Mainnet RPC URL and network passphrase instead; any other value for `STELLAR_NETWORK` SHALL cause the script to exit with a non-zero code and an error message written to stderr.

---

### Requirement 13: Contract Testing

**User Story:** As a developer, I want a comprehensive test suite for the Subscription_Contract, so that I can verify correctness of all state transitions and prevent regressions.

#### Acceptance Criteria

1. THE test suite SHALL include an integration test that executes the full subscription lifecycle in sequence: (a) calls `subscribe` and asserts that `SubscriptionData` is stored with correct fields; (b) advances the ledger clock past `next_payment`; (c) calls `execute_payment` and asserts that the Subscriber's token balance decreases by `amount` and the Merchant's balance increases by `amount`; (d) calls `cancel` and asserts that the SubscriptionData entry no longer exists in storage.
2. THE test suite SHALL include a test that calls `subscribe`, then immediately calls `execute_payment` without advancing the ledger clock, and asserts that `execute_payment` returns an error (panics or returns `Err`) and that the Subscriber's token balance remains unchanged.
3. THE test suite SHALL include a test that calls `subscribe`, calls `cancel`, then calls `execute_payment`, and asserts that `execute_payment` returns a "no active subscription found" error and that no token transfer occurs.
4. THE test suite SHALL include a test that calls `subscribe` with `amount = 0` and asserts that the call returns an error and that no SubscriptionData entry is created in storage.
5. THE test suite SHALL include a test that calls `subscribe` with `interval = 86399` (one second below the minimum) and asserts that the call returns an error and that no SubscriptionData entry is created in storage.
6. THE test suite SHALL include a property-based test that generates valid `(amount, interval)` pairs where `amount > 0` and `86400 <= interval <= 31536000`, calls `subscribe` followed immediately by `execute_payment` (without advancing the ledger clock), and asserts for every generated input that `execute_payment` returns an error and the Subscriber's balance is unchanged.
7. THE test suite SHALL include a property-based test that generates valid subscriptions, advances the ledger clock to execute one payment successfully, then calls `execute_payment` a second time without further advancing the clock, and asserts for every generated input that the second call returns an error and the Subscriber's balance reflects exactly one deduction.
8. THE test suite SHALL include a property-based test that generates valid `(amount, interval)` pairs where `amount > 0` and `86400 <= interval <= 31536000`, calls `subscribe`, reads the stored `next_payment` from SubscriptionData, and asserts for every generated input that `next_payment == ledger_timestamp_at_subscribe + interval`.
9. THE test suite SHALL include a round-trip property test that generates valid `(token, amount, interval)` tuples, calls `subscribe(subscriber, merchant, token, amount, interval)`, reads the stored SubscriptionData, and asserts for every generated input that the stored record contains `token`, `amount`, `interval`, and `next_payment == ledger_timestamp_at_subscribe + interval` with all four fields matching their input or derived values exactly.
10. THE test suite SHALL include tests verifying that the `subscribe` event (topics: `[symbol("subscribe"), subscriber, merchant]`, data: `amount`) is emitted exactly once per successful `subscribe` call, and that the `executed` event (topics: `[symbol("executed"), subscriber, merchant]`, data: `amount`) is emitted exactly once per successful `execute_payment` call, with topic and data values matching the call arguments.
11. THE test suite SHALL include tests verifying that no `subscribe` or `executed` events are emitted when `subscribe` is called with invalid inputs (amount ≤ 0 or interval < 86400), when `execute_payment` is called before `next_payment` has elapsed, or when `execute_payment` is called on a cancelled subscription.
