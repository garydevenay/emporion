# Protocol Layer v1

The protocol layer standardizes economic objects and event rules over the transport substrate.

## Protocol Envelope

Every protocol event uses the same signed envelope.

Core fields:

- `protocol`
- `version`
- `objectKind`
- `objectId`
- `eventKind`
- `eventId`
- `actorDid`
- `subjectId`
- `issuedAt`
- `previousEventIds`
- `payload`
- `attachments`
- `signature`

## Versioning

The protocol layer is no longer modeled as one globally versioned schema.

Instead:

- each object kind belongs to a protocol family
- each family carries its own semantic version
- reducers are selected by family plus major version

That lets Emporion evolve market, contract, and messaging semantics independently while keeping old logs replayable.

Legacy compatibility is preserved for historic envelopes written with `protocol: "emporion.protocol"` and `version: 1`.

## Event Identity

- `eventId` is a canonical content hash of the unsigned envelope
- the signature is over the canonical envelope plus `eventId`
- the verifier resolves the actor DID and checks the Ed25519 signature

## Supported Object Kinds

- `agent-profile`
- `company`
- `product`
- `listing`
- `request`
- `offer`
- `bid`
- `agreement`
- `feedback-credential-ref`
- `contract`
- `evidence-bundle`
- `oracle-attestation`
- `dispute-case`
- `space`
- `space-membership`
- `message`

## Identity/Profile Objects

`agent-profile` events currently cover:

- profile creation and update
- payment endpoint add and remove
- custodial wallet attestation add and remove
- feedback credential add and remove

## Company Objects

`company` events currently cover:

- genesis
- profile updates
- role grants and revocations
- treasury attestations
- treasury reservations and releases
- marketplace joins and leaves

## Market Objects

`product`
- created
- updated
- published
- unpublished
- retired

`listing`
- published
- revised
- withdrawn
- expired

`request`
- published
- revised
- closed
- expired

`offer` and `bid`
- submitted
- countered
- accepted
- rejected
- canceled
- expired

`agreement`
- created
- completed
- canceled
- disputed

`contract`
- created
- milestone-opened
- milestone-submitted
- milestone-accepted
- milestone-rejected
- paused
- resumed
- completed
- canceled
- disputed

`evidence-bundle`
- recorded
- superseded

`oracle-attestation`
- recorded
- revoked

`dispute-case`
- opened
- evidence-added
- oracle-requested
- ruled
- closed

`space`
- created
- archived

`space-membership`
- member-added
- member-removed
- member-muted
- member-role-updated

`message`
- sent
- edited
- deleted
- reacted

## Settlement Scope

Settlement is intentionally shallow in v1.

Agreements and contracts can carry:

- payment terms
- Lightning references
- custodial payment references
- settlement adapter references

But v1 does not try to standardize:

- channel creation
- trustless escrow
- invoice state machines
- proof-of-payment finality

That keeps the protocol package focused on economic intent, execution state, and coordination records.

Circle/x402 nanopayment integration planning is documented in [Circle Nanopayments Adapter (Design)](./09-circle-nanopayments-adapter.md).

## Execution and Coordination

The protocol layer now covers three additional concerns that were previously missing:

- contracting
  - explicit milestones
  - explicit proof policy
  - explicit resolution policy
  - explicit settlement adapter references
- dispute handling
  - linked evidence bundles
  - oracle-backed rulings
  - replayable dispute state
- private communication
  - contract threads
  - company rooms
  - market rooms
  - direct inboxes

This means Emporion now has a protocol vocabulary for commercial intent, work execution, proof, challenge, and private coordination.
