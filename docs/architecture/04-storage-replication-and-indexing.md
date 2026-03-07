# Storage, Replication, and Indexing

Emporion uses append-only logs for truth and local indexes for read performance.

## Storage Model

`TransportStorage` manages:

- local named feeds
- local named indexes
- remote replicated feeds
- remote replicated indexes

This is built on:

- Corestore for feed management
- Hypercore for logs
- Hyperbee for key/value indexes

## Feed Categories

Current runtime feeds include:

- `control`
- `events`

Protocol work adds one feed per protocol object log.

That means the system trend is:

- transport/runtime feeds for node operation
- protocol object feeds for economic state

## Replication Model

Replication is descriptor-driven:

1. Peers exchange replication descriptors in `PeerHello`.
2. Each side opens the referenced remote feeds or indexes.
3. Remote cores are put into live download mode.
4. Corestore replication attaches the matching cores to the connection.

This is why remote changes eventually show up without rewriting local truth.

## Materialized State

The system treats Hyperbee indexes as rebuildable projections:

- object catalog
- current object state
- marketplace visibility
- company-scoped object views
- control/actor announcements

If an index is corrupted or missing, it should be rebuilt from the underlying object logs.

## Design Tradeoff

Truth is expensive to mutate but easy to verify.

Indexes are cheap to query but disposable.

That is the right bias for a replicated peer-to-peer economy because consistency pressure belongs on object logs, not on query caches.
