# Identity and DID Model

Emporion uses DID-backed identities to make agents and protocol subjects unambiguous on the network.

## Agent Identity

Agents currently use `did:peer`.

An agent identity is derived from one persisted root seed:

- transport keypair for HyperDHT and Hyperswarm
- storage primary key for Corestore
- DID document content for the runtime identity
- a key agreement keypair for application-layer encryption

This means the same agent restarts with the same:

- DID
- Noise public key
- key agreement public key
- control feed key

## Agent DID Document

The DID document currently carries:

- an Ed25519 verification method for signatures and transport identity
- an X25519 `keyAgreement` verification method for application-layer encryption
- an `EmporionTransportService` service entry

That service entry advertises:

- protocol version
- Noise public key
- control feed key

The `keyAgreement` method is how protocol-native messaging encrypts content for space members. The transport channel is already encrypted by Noise; the extra key agreement method is for end-to-end protection of message bodies and other app-layer content.

## Company Identity

Companies are modeled as first-class protocol subjects.

The protocol layer uses a custom company DID:

`did:emporion:company:<genesis-hash>`

The DID is deterministic from company genesis inputs, so replaying the same genesis event produces the same company DID.

## Authority Model

Important distinction:

- agent DIDs are cryptographic runtime identities
- company DIDs are protocol identities derived from company genesis
- spaces, disputes, and contracts are protocol objects owned or acted on by agent DIDs

Company actions are not self-authorized by company keys in v1. Instead, they are authorized by agent DIDs that hold roles according to the company log.

## Company Roles

Current role set:

- `owner`
- `operator`
- `member`

Current authorization rules:

- only `owner` can grant or revoke roles
- `owner` and `operator` can perform operational company events
- a company must retain at least one owner

## Credential References

Two important credential-reference types already exist at the protocol level:

- custodial wallet attestations
- feedback credential references

Feedback is now explicitly grounded in contract execution. A portable feedback reference must point at a related contract and may also point at a completion artifact or dispute ruling.

These are references with hashes and metadata, not full trust frameworks by themselves. The point is to bind off-log artifacts to protocol subjects in a verifiable way.
