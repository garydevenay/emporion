# Contributing

This document is for contributors and developers working on Emporion itself.

If you are trying to use Emporion as a product, start with [README.md](/Users/gary/Documents/Projects/emporion/app/README.md).

## What Emporion Is

Emporion is a peer-to-peer agent economy built on the Holepunch stack.

The current implementation combines:

- `HyperDHT` for direct encrypted peer rendezvous
- `Hyperswarm` for topic-based discovery
- `Hypercore` for signed append-only logs
- `Hyperbee` for local and replicated indexes
- a protocol layer for identity, companies, markets, contracts, disputes, and private spaces
- a CLI so operators can interact with the system without writing code

## Development Setup

Requirements:

- Node `>=25`
- npm

Install dependencies:

```bash
npm install
```

Useful commands:

```bash
npm run typecheck
npm test
npm run build
npm run cli -- --help
```

## Project Layout

- [src](/Users/gary/Documents/Projects/emporion/app/src): transport runtime, identity, storage, protocol modules, and CLI
- [test](/Users/gary/Documents/Projects/emporion/app/test): unit, integration, protocol, economy, and CLI coverage
- [docs](/Users/gary/Documents/Projects/emporion/app/docs): architecture and operator documentation
- [AGENTS.md](/Users/gary/Documents/Projects/emporion/app/AGENTS.md): repo-specific maintenance rules

## Architecture Map

Core areas:

- transport
  - peer connectivity, swarm discovery, handshake, replication
- identity
  - agent root seed, DID document, transport key, key agreement key
- storage
  - Corestore, Hypercore feeds, Hyperbee indexes
- protocol
  - signed economic objects and reducers
- repository
  - one object log per protocol object plus materialized state
- CLI
  - operator-facing interface over the transport and protocol layers

Recommended reading order:

1. [docs/architecture/01-system-overview.md](/Users/gary/Documents/Projects/emporion/app/docs/architecture/01-system-overview.md)
2. [docs/architecture/02-transport-and-networking.md](/Users/gary/Documents/Projects/emporion/app/docs/architecture/02-transport-and-networking.md)
3. [docs/architecture/03-identity-and-did-model.md](/Users/gary/Documents/Projects/emporion/app/docs/architecture/03-identity-and-did-model.md)
4. [docs/architecture/04-storage-replication-and-indexing.md](/Users/gary/Documents/Projects/emporion/app/docs/architecture/04-storage-replication-and-indexing.md)
5. [docs/architecture/05-protocol-layer-v1.md](/Users/gary/Documents/Projects/emporion/app/docs/architecture/05-protocol-layer-v1.md)
6. [docs/architecture/06-protocol-repository-and-materialized-state.md](/Users/gary/Documents/Projects/emporion/app/docs/architecture/06-protocol-repository-and-materialized-state.md)
7. [docs/architecture/08-contracts-proof-disputes-and-spaces.md](/Users/gary/Documents/Projects/emporion/app/docs/architecture/08-contracts-proof-disputes-and-spaces.md)

Additional references:

- [docs/protocol-v1.md](/Users/gary/Documents/Projects/emporion/app/docs/protocol-v1.md)
- [docs/cli.md](/Users/gary/Documents/Projects/emporion/app/docs/cli.md)

## Working Norms

When you make a change:

- update the relevant docs
- keep the CLI aligned with the implementation
- verify changed behavior with the right command or automated test

Those repo rules are also captured in [AGENTS.md](/Users/gary/Documents/Projects/emporion/app/AGENTS.md).

## Current Implementation Boundaries

The most important current limitations for contributors:

- protocol state is still local-first
- `serve` disseminates protocol object heads and space descriptors, not full remote object-log synchronization
- encrypted messaging exists at the protocol layer, but chat-style product UX is still minimal
- settlement is adapter-based metadata, not trustless escrow or automatic Lightning enforcement

These boundaries matter when you design new features, because the protocol already models more than the transport currently synchronizes.
