# Testing and Operational Notes

This project now has two main kinds of tests:

- transport/runtime tests
- protocol/repository tests
- wallet runtime and settlement tests

## Transport Test Coverage

Transport tests currently verify:

- topic discovery
- direct DID dialing
- peer handshake validation
- DID-to-Noise binding rejection
- replication visibility
- clean restart and shutdown

The transport integration replication assertion now waits for a specific appended block index to become fetchable on the remote feed. This keeps the test scoped to in-process transport behavior and avoids depending on passive background update timing.

## Protocol Test Coverage

Protocol tests currently verify:

- agent profile signature validation
- deterministic company DID generation
- company role authorization rules
- treasury and feedback credential validation
- market state transitions
- agreement creation from accepted negotiations
- repository rebuild and marketplace visibility

## Wallet Runtime Test Coverage

Wallet tests now verify:

- encrypted wallet secret storage (AES-256-GCM), key mismatch handling, and key rotation
- NWC adapter success/error/timeout normalization into wallet domain errors
- local ledger transitions for invoices and payments
- auto-settle idempotency via `(eventId, lightning reference)` dedupe
- daemon wallet integration with mocked NWC backend:
  - connect + status
  - offer acceptance auto-settle trigger
  - pending payment recovery after daemon restart
  - daemon startup with locked wallet state when `EMPORION_WALLET_KEY` is missing
- Circle/x402 backend coverage:
  - circle connection URI parsing and metadata persistence
  - adapter payment execution + status mapping + auth/timeout normalization
  - CLI `wallet connect circle` and `wallet pay x402` flow

Circle/x402 coverage is tracked as a planned expansion in [Circle Nanopayments Adapter (Design)](./09-circle-nanopayments-adapter.md).

## Operational Expectations

- Losing a local index should be recoverable by replaying logs.
- Losing object logs is data loss.
- Transport rejection paths should be explicit and observable.
- Demo output is only a debugging tool, not the final operator interface.
- Wallet runtime persistence is local-only in v1:
  - connection metadata + encrypted secret under `<data-dir>/runtime/wallet`
  - invoice/payment/auto-settle ledger under `<data-dir>/runtime/wallet/ledger.v1.json`
- Daemon can start without wallet key; wallet status reports `autoSettleEnabled: false` until a valid key is provided via env/proxied wallet command.
- With the current CLI, daemon wallet sessions can be unlocked/locked explicitly via `wallet unlock` and `wallet lock` (in-memory only, cleared on daemon stop).
- Auto-settle is currently unrestricted in v1 and runs on accepted offer/bid + active agreement opportunities when actionable Lightning refs are present.

## Current Limitations

- no trustless Bitcoin settlement
- no protocol-replicated wallet ledger objects (runtime-only ledger in v1)
- no company transfer protocol
- no protocol-native hiring workflow yet (current `deal` commands are local orchestration wrappers)
- no protocol-level escrow
- no final product storefront UX

## Recommended Next Documentation

After these architecture docs, the next useful docs would be:

- a developer workflow guide
- a protocol event cookbook with examples
- an object lifecycle reference table
- a future settlement design note
