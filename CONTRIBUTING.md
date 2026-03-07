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

## GitHub Actions

The repository now ships two GitHub Actions workflows:

- `.github/workflows/ci.yml`
  - runs on pushes to `main` and on pull requests
  - installs dependencies
  - runs `typecheck`, `test`, `build`, and a CLI smoke check
- `.github/workflows/publish.yml`
  - runs when a GitHub release is published
  - can also be triggered manually with `workflow_dispatch`
  - verifies the release tag matches `package.json`
  - builds and publishes the npm package

## npm Release Process

The publish workflow expects:

- the package version in `package.json` to be the version you want to ship
- a GitHub release tag in the form `v<package-version>`
- an `NPM_TOKEN` repository secret with publish rights to the npm package

Recommended release flow:

1. Update `package.json` version.
2. Run `npm test` and `npm run build` locally.
3. Merge to `main`.
4. Create and publish a GitHub release tagged `v<version>`.
5. Let the publish workflow push the package to npm.

The workflow publishes with npm provenance enabled.

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
  - operator-facing interface plus the background daemon and local IPC control plane

## CLI Runtime Model

Emporion now supports two execution modes:

- direct mode: if no daemon is running for a `data-dir`, a CLI command opens the local stores in-process
- daemon-backed mode: if a daemon is active for that `data-dir`, normal CLI commands proxy over local IPC to the background runtime

Runtime artifacts live under `<data-dir>/runtime`:

- `daemon.pid`
- `daemon.log`
- `daemon.sock` on POSIX or a deterministic named pipe on Windows

This is the main protection against multi-process contention on transport and protocol storage. If you change the CLI or runtime behavior, update both the command surface and the daemon path together.

## Protocol Versioning

Emporion now versions protocol envelopes by family, not by one global protocol number.

Current families:

- `emporion.identity`
- `emporion.company`
- `emporion.market`
- `emporion.contract`
- `emporion.messaging`

Current write behavior:

- new envelopes are emitted with a family-specific semantic version such as `1.0`
- reducers dispatch by `family + major version`
- additive evolution is expected inside a major version

Backward compatibility rule:

- historic legacy envelopes using `protocol: "emporion.protocol"` and `version: 1` still validate and replay
- new breaking semantics must move to a new major version instead of changing the meaning of old events

Transport handshake stays separately versioned. Peers also advertise supported protocol families and major versions in `PeerHello` so mixed-version deployments can negotiate capabilities cleanly.

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
- the daemon disseminates protocol object heads and space descriptors, not full remote object-log synchronization
- encrypted messaging exists at the protocol layer, but chat-style product UX is still minimal
- settlement is adapter-based metadata, not trustless escrow or automatic Lightning enforcement
- projection storage is not yet independently schema-versioned beyond log replay, so future projection migrations should be designed carefully

These boundaries matter when you design new features, because the protocol already models more than the transport currently synchronizes.
