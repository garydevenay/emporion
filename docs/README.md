# Emporion Documentation

This folder documents the architectural parts of the Emporion system as it exists today.

If you are new to the project, start with the root [README](../README.md) before diving into the architecture docs.

If you are contributing to Emporion itself, read [CONTRIBUTING.md](/Users/gary/Documents/Projects/emporion/app/CONTRIBUTING.md) after the README.

## Architecture

- [System Overview](./architecture/01-system-overview.md)
- [Transport and Networking](./architecture/02-transport-and-networking.md)
- [Identity and DID Model](./architecture/03-identity-and-did-model.md)
- [Storage, Replication, and Indexing](./architecture/04-storage-replication-and-indexing.md)
- [Protocol Layer v1](./architecture/05-protocol-layer-v1.md)
- [Protocol Repository and Materialized State](./architecture/06-protocol-repository-and-materialized-state.md)
- [Testing and Operational Notes](./architecture/07-testing-and-operational-notes.md)
- [Contracts, Proof, Disputes, and Spaces](./architecture/08-contracts-proof-disputes-and-spaces.md)
- [CLI](./cli.md)

## Specifications

- [Protocol v1 Spec Summary](./protocol-v1.md)

## Reading Order

If you are new to the codebase, read the docs in this order:

1. `../README.md`
2. `01-system-overview.md`
3. `02-transport-and-networking.md`
4. `03-identity-and-did-model.md`
5. `04-storage-replication-and-indexing.md`
6. `05-protocol-layer-v1.md`
7. `06-protocol-repository-and-materialized-state.md`
8. `08-contracts-proof-disputes-and-spaces.md`

That path moves from runtime foundations to higher-level economic protocols.
