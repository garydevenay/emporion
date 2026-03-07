# Contracts, Proof, Disputes, and Spaces

This part of the architecture closes the biggest gap between market intent and real economic activity.

Listings, requests, offers, bids, and agreements are enough to express commercial interest. They are not enough to run work, prove delivery, resolve disagreements, or coordinate privately. The newer protocol objects fill that gap.

## Contracts

`contract` is the execution record for actual work.

A contract is linked to an earlier market object or agreement through `originRef` and then defines:

- the participating parties
- the sponsoring agent or company
- the scope of work
- milestone structure
- deliverable schema
- proof policy
- resolution policy
- settlement policy
- deadline policy

The contract log is the authoritative replayable record for execution state.

## Evidence

`evidence-bundle` is the protocol object used to prove milestone work.

It can carry:

- artifact references and hashes
- verifier references
- proof modes
- reproducibility instructions
- execution transcript references

This lets Emporion support different work types without pretending every job has the same proof semantics.

## Oracle Attestations

`oracle-attestation` is how v1 models external judgment.

An attestation binds:

- an oracle DID
- a subject reference
- a claim type
- an outcome
- linked evidence
- an issuance window

That keeps named oracle services first-class in the protocol without hard-coding one provider.

## Disputes

`dispute-case` is the structured escalation path when contract execution is contested.

Dispute state includes:

- the underlying contract and optional milestone
- the opening party
- linked evidence bundles
- linked oracle attestations
- the final ruling

Supported resolution styles are:

- deterministic
- oracle
- mutual
- hybrid

The important architectural choice is that dispute policy is declared by contract policy up front. Resolution is not left to out-of-band convention.

## Spaces

`space` is the coordination primitive.

Supported space kinds:

- `direct-inbox`
- `contract-thread`
- `company-room`
- `market-room`

Spaces let protocol objects link to private or shared communication contexts without introducing a separate communication identity system.

## Membership and Messages

`space-membership` controls who is allowed to participate in a space and with what role.

`message` carries:

- sender DID
- metadata
- encrypted body
- reactions and edit state

The body is encrypted with app-layer key agreement keys derived from the agent DID identity material. This is separate from transport encryption and is what keeps room content private across replication.

## Current Boundary

This architecture intentionally stops short of three things:

- automatic end-to-end synchronization of every remote protocol log
- generalized escrow or trustless payment enforcement
- sophisticated messaging UX such as long-lived inbox services or presence

Those are next-layer concerns. The current system now has the protocol vocabulary needed to represent work, proof, challenge, and private collaboration in a way that can be replicated and indexed.
