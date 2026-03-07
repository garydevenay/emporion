# Transport and Networking

The transport layer is the low-level runtime that makes peers discoverable, connectable, and able to replicate feeds.

## Building Blocks

- `HyperDHT`
  Used for direct rendezvous and encrypted point-to-point sockets.
- `Hyperswarm`
  Used for topic-based discovery and managed peer connectivity.
- `Hypercore`
  Used for signed append-only logs.
- `Hyperbee`
  Used for local and replicated indexes over Hypercore-backed data.
- `Corestore`
  Used to manage many Hypercores under one storage root.

## Runtime Lifecycle

`AgentTransport.create()`:

1. Normalizes config.
2. Ensures the data directory exists.
3. Loads or creates the persisted root identity.
4. Creates local storage.
5. Opens default feeds.
6. Builds the DID-backed agent identity.
7. Instantiates HyperDHT and Hyperswarm with the derived transport keypair.

`start()`:

1. Starts listening for inbound swarm connections.
2. Registers connection, update, and ban handlers.
3. Makes the agent reachable for topic and direct-connect traffic.

## Connection Model

There are two connection paths:

- Topic discovery via `joinTopic(...)`
- Direct dialing via `connectToDid(...)` or `connectToNoiseKey(...)`

All connected sockets go through the same handshake path:

1. Exchange `PeerHello`.
2. Resolve the remote DID.
3. Verify the DID-to-Noise binding.
4. Track remote replication descriptors.
5. Start Corestore replication.

Handshake frames are read in exact byte lengths using the socket `readable` interface (not streaming `data` listeners). This avoids byte-boundary races when handing control from the custom handshake framing to Hypercore replication on the same socket.

`PeerHello` is transport-scoped, not protocol-object-scoped. It still has its own transport version, but peers now also advertise the protocol families and major versions they support. That gives the higher protocol layer room to evolve independently from the transport handshake.

## Topic Model

Current topic kinds:

- `agent`
- `company`
- `marketplace`

Topic keys are derived by hashing canonical topic strings. This keeps transport discovery stable and deterministic.

## Error Boundaries

The transport layer rejects peers when:

- the socket never opens
- the handshake times out
- the handshake payload is invalid
- the remote DID does not match the socket key
- the remote control feed claim does not match the DID document

## Design Notes

- Transport is generic and protocol-agnostic.
- Replication is feed-based, not message-bus-based.
- A peer connection can carry multiple protocol object replications over one encrypted stream.
