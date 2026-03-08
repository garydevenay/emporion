# Circle Nanopayments Adapter (Design and Rollout Plan)

This note defines how Emporion should integrate Circle's agentic nanopayments stack (x402 + USDC authorization flows) as a first-class payment adapter.

Status: partially implemented.

Implemented now:

- Circle backend connection path in wallet runtime (`wallet connect circle`)
- Circle adapter scaffolding for payment execution/status (`wallet pay x402`)
- test coverage for Circle adapter auth/timeout/CLI integration

Still pending:

- protocol-level rail-neutral payment references
- ledger/accounting schema generalization beyond sats-centric fields
- auto-settle support for Circle-specific reference types

## Why This Needs a Design Pass First

Emporion's current wallet runtime is Lightning-first:

- command surface is `wallet connect nwc`, `wallet invoice create`, `wallet pay bolt11`
- wallet amount fields are sats (`amountSats`)
- auto-settle only executes `bolt11` references
- protocol payment refs are modeled as `LightningReference`

Circle nanopayments are different:

- payment rail is x402 (HTTP 402 challenge/response), not BOLT11
- value unit is USDC (sub-cent units), not sats
- execution is authorization-first (offchain signatures + batched settlement)

Directly "dropping Circle into the existing bolt11-only interface" would create incorrect unit assumptions and brittle behavior.

## Target Outcome

Agents should be able to:

1. advertise Circle/x402 payment capability in profile metadata
2. attach Circle payment references to offers/bids/agreements/contracts
3. execute nano settlement through a Circle adapter in daemon auto-settle and direct CLI flows
4. keep Lightning compatibility unchanged for existing agents

## Architecture Changes Required

### 1) Generalize payment request model (runtime)

Introduce a rail-aware request type in wallet runtime:

- `bolt11` (existing Lightning path)
- `x402` (new Circle nano path)
- keep `custodial-payment-ref` as compatibility alias during migration

Recommended type direction:

- replace `PayInvoiceInput`/`payInvoice` as primary API with `PayRequestInput`/`payRequest`
- keep `payInvoice` as a backward-compatible wrapper to `payRequest({ rail: "bolt11", ... })`

### 2) Add a Circle adapter contract

Add `CircleNanoWalletAdapter` with:

- connection metadata parser for a `circle+...` URI scheme
- credential handling from encrypted runtime wallet secret
- explicit idempotency key generation per payment attempt
- status polling mapped to wallet ledger states (`pending | succeeded | failed`)

Do not force Circle into sats math. Carry a rail-native amount object in adapter internals and only project into existing ledger fields through explicit conversion policy.

### 3) Extend wallet ledger for multi-rail accounting

Current ledger records assume sats-only semantics.

Add optional fields to `PaymentRecord`/`InvoiceRecord`:

- `rail` (`bolt11` | `x402` | future)
- `asset` (`BTC` | `SAT` | `USDC`)
- `amountMinor` (rail-native integer minor units)
- `displayAmount` (human-readable string for CLI output)

Keep `amount`/`fee` sats fields for backward compatibility during migration.

### 4) Protocol and reducer evolution

Current protocol references use `LightningReference`.

Add a neutral payment reference model (for v1.1/v2 planning):

- `PaymentReference` with `type`, `network`, `asset`, `reference`
- preserve existing lightning fields and parse them into `PaymentReference` internally
- support Circle-oriented reference types (for example `x402-resource`, `circle-authorization-ref`)

This keeps contracts/disputes rail-agnostic while still traceable.

### 5) CLI additions and compatibility

Add:

- `wallet connect circle --connection-uri <circle+...>`
- `wallet pay x402 --resource <url-or-ref> [--max-usdc-micros <n>]`
- `wallet request create x402 ...` (optional seller-side support if we expose local paid endpoints)

Keep existing commands unchanged:

- `wallet connect nwc`
- `wallet invoice create`
- `wallet pay bolt11`

## Security and Operational Controls

1. Keep Circle API credentials only in encrypted wallet secret material (`runtime/wallet/connection.secret.enc.json`).
2. Require deterministic idempotency keys for retriable operations.
3. Persist provider transaction/payment IDs as immutable `externalRef`.
4. Enforce strict timeout + retry budgets in adapter calls.
5. Ensure daemon restart reconciliation can recover pending Circle payments exactly once.

## TDD Implementation Sequence

Implement in vertical slices, always test-first:

### Slice A: Connection + metadata

- tests:
  - parse/validate `circle+` connection URI
  - config store round-trip for backend/network metadata
  - CLI `wallet connect circle` success + error cases

### Slice B: Runtime pay request abstraction

- tests:
  - `walletService.payRequest` with bolt11 remains behaviorally identical
  - unsupported rail returns explicit `WalletUnavailableError`

### Slice C: Circle adapter payment execution

- tests:
  - create/pay/status mapping from mocked Circle/x402 responses
  - auth and timeout normalization
  - idempotency replay behavior

### Slice D: Auto-settle + protocol refs

- tests:
  - auto-settle executes for Circle-compatible refs
  - dedupe key stays stable across restarts
  - mixed rail environments (Lightning + Circle) coexist

## Backward Compatibility Rules

- Existing `nwc` flows must keep passing unchanged tests.
- Existing CLI command names and response shapes must stay stable unless explicitly versioned.
- Existing protocol objects with `lightningRefs` must remain valid and replayable.

## Open Decisions

1. Canonical Circle reference type names in protocol payloads.
2. Whether USDC is represented in protocol as micros only or `{ amount, decimals }`.
3. Minimum viable CLI for seller-side x402 endpoint publishing.
4. Whether Circle support ships as core runtime code or optional adapter package.

## Recommended Next Implementation PR

First coding PR should deliver Slice A only:

- add `circle` backend parsing + wallet connect CLI path
- keep execution commands (`pay`/`invoice`) unchanged
- include docs + tests

This creates a safe foundation for Circle integration without introducing incorrect payment semantics.
