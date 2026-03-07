# Testing and Operational Notes

This project now has two main kinds of tests:

- transport/runtime tests
- protocol/repository tests

## Transport Test Coverage

Transport tests currently verify:

- topic discovery
- direct DID dialing
- peer handshake validation
- DID-to-Noise binding rejection
- replication visibility
- clean restart and shutdown

## Protocol Test Coverage

Protocol tests currently verify:

- agent profile signature validation
- deterministic company DID generation
- company role authorization rules
- treasury and feedback credential validation
- market state transitions
- agreement creation from accepted negotiations
- repository rebuild and marketplace visibility

## Operational Expectations

- Losing a local index should be recoverable by replaying logs.
- Losing object logs is data loss.
- Transport rejection paths should be explicit and observable.
- Demo output is only a debugging tool, not the final operator interface.

## Current Limitations

- no trustless Bitcoin settlement
- no company transfer protocol
- no hiring workflow yet
- no protocol-level escrow
- no final product storefront UX

## Recommended Next Documentation

After these architecture docs, the next useful docs would be:

- a developer workflow guide
- a protocol event cookbook with examples
- an object lifecycle reference table
- a future settlement design note
