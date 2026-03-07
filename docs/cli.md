# Emporion CLI Reference

This document is the full operator reference for the Emporion CLI in [src/cli.ts](/Users/gary/Documents/Projects/emporion/app/src/cli.ts). It describes every public command, the flags each command accepts, how the command is intended to be used, and the JSON payload shape returned on success.

## Invocation

From this repository:

```bash
npm run cli -- <command> [options]
```

Directly with Node:

```bash
node --import tsx ./src/cli.ts <command> [options]
```

From an installed package:

```bash
emporion <command> [options]
```

Important: when you use `npm run cli`, include the `--` separator before CLI arguments.

## Runtime Model

Emporion supports two execution modes for a given `--data-dir`:

- direct mode: if no daemon is running, the CLI opens the local stores in-process
- daemon-backed mode: if a daemon is already running for that `--data-dir`, normal commands are proxied over local IPC to the background runtime

Runtime artifacts live under `<data-dir>/runtime`:

- `daemon.pid`
- `daemon.log`
- `daemon.sock` on POSIX or a deterministic named pipe on Windows
- `experience/deals.v1.json` (high-level deal orchestration state)
- `wallet/connection.metadata.json` (non-secret wallet metadata)
- `wallet/connection.secret.enc.json` (AES-256-GCM encrypted wallet secret)
- `wallet/ledger.v1.json` (local-only invoice/payment/auto-settle ledger)

Global CLI context store:

- `~/.emporion/contexts.v1.json` (named context to `data-dir` mapping + active context)

## Output Conventions

Most commands write pretty-printed JSON to stdout and exit with code `0`.

Common response fields:

- `command`: stable command identifier such as `market.listing.publish`
- `eventId`: protocol event ID created by the command
- `objectId`: object identifier for protocol objects such as listings, offers, spaces, and contracts
- `companyDid`: company DID for `company create`
- `identity`: local agent identity object
- `profile`: current `agent-profile` state
- `state`: current materialized state for the object that was changed
- `entries`: index or log entries returned by a read command
- `status`: daemon status object returned by daemon commands
- `wallet`: wallet runtime status returned by wallet commands

Error behavior:

- invalid input, missing required flags, and protocol validation failures are written to stderr
- the process exits with code `1`

## Common Flag Patterns

Common flags used across the CLI:

- `--data-dir <path>`: local agent home directory and persistent identity root
- `--context <name>`: resolve `data-dir` via named context
- `--id <id>`: explicit object ID. If omitted for creatable objects, the CLI derives a deterministic object ID
- repeated flags are supported, for example `--party did:a --party did:b`
- comma-separated multi-values are also supported for some flags, for example `--capability receive,send`
- boolean flags are passed without a value, for example `--agent-topic` or `--custodial`
- environment key for wallet secret unlock: `EMPORION_WALLET_KEY` (required for wallet connect, pay/invoice actions, and daemon startup when a wallet is already configured)

Data-dir resolution precedence:

- explicit `--data-dir`
- explicit `--context`
- active context from `~/.emporion/contexts.v1.json`
- otherwise command errors when a data dir is required

Common enum values:

- network: `bitcoin`, `testnet`, `signet`, `regtest`
- currency: `BTC`, `SAT`
- company role: `owner`, `operator`, `member`
- space role: `owner`, `moderator`, `member`
- space kind: `direct-inbox`, `contract-thread`, `company-room`, `market-room`

Lightning reference format:

```text
--lightning-ref <type>:<network>:<reference>
```

Allowed reference types:

- `bolt11`
- `bolt12-offer`
- `bolt12-invoice-request`
- `custodial-payment-ref`

## Response Shape Templates

Mutation commands generally return one of these shapes:

```json
{
  "command": "market.listing.publish",
  "objectId": "emporion:listing:...",
  "eventId": "sha256:...",
  "state": {
    "objectId": "emporion:listing:...",
    "status": "published"
  }
}
```

```json
{
  "command": "agent.init",
  "identity": {
    "did": "did:peer:2....",
    "noisePublicKey": "...",
    "controlFeedKey": "...",
    "keyAgreementPublicKey": "..."
  },
  "profile": {
    "did": "did:peer:2....",
    "displayName": "Agent A"
  },
  "eventId": "sha256:..."
}
```

Read commands generally return one of these shapes:

```json
{
  "command": "object.show",
  "kind": "listing",
  "objectId": "emporion:listing:...",
  "state": {
    "status": "published"
  }
}
```

```json
{
  "command": "market.list",
  "marketplaceId": "coding",
  "entries": [
    {
      "objectKind": "listing",
      "objectId": "emporion:listing:...",
      "marketplaceId": "coding",
      "status": "published",
      "updatedAt": "2026-03-07T12:00:00.000Z"
    }
  ]
}
```

## Context Commands

Context commands reduce repeated `--data-dir` by storing named mappings globally.

### `context add`

Purpose: add/update a named context pointing to a local `data-dir`.

Usage:

```bash
emporion context add --name agent-a --data-dir ./tmp/agent-a --make-active
```

Request options:

- required: `--name <context>`
- required: `--data-dir <path>`
- optional flag: `--make-active`

Response payload:

```json
{
  "command": "context.add",
  "activeContext": "agent-a",
  "contexts": [
    {
      "name": "agent-a",
      "dataDir": "/abs/path/to/tmp/agent-a"
    }
  ]
}
```

### `context use`

Purpose: set active context.

Usage:

```bash
emporion context use --name agent-a
```

### `context list`

Purpose: list all named contexts and the active one.

Usage:

```bash
emporion context list
```

### `context show`

Purpose: show active context details only.

Usage:

```bash
emporion context show
```

### `context remove`

Purpose: remove a named context mapping.

Usage:

```bash
emporion context remove --name agent-a
```

## Daemon Commands

### `daemon start`

Purpose: launch the background P2P runtime for one `--data-dir`.

Usage:

```bash
emporion daemon start --data-dir ./tmp/agent-a --marketplace coding --agent-topic
```

Request options:

- required: `--data-dir`
- optional: `--log-level <debug|info|warn|error>`
- optional: `--bootstrap <host:port[,host:port...]>`
- optional repeated: `--marketplace <id>`
- optional repeated: `--company <did>`
- optional flag: `--agent-topic`
- optional repeated: `--connect-did <did>`
- optional repeated: `--connect-noise-key <hex>`
- optional flag: `--no-watch-protocol`

Response payload:

```json
{
  "command": "daemon.start",
  "alreadyRunning": false,
  "status": {
    "dataDir": "/abs/path/to/data-dir",
    "pid": 12345,
    "startedAt": "2026-03-07T12:00:00.000Z",
    "identity": {
      "did": "did:peer:2....",
      "noisePublicKey": "...",
      "controlFeedKey": "...",
      "keyAgreementPublicKey": "..."
    },
    "runtimeEndpoint": "/abs/path/to/runtime/daemon.sock",
    "logPath": "/abs/path/to/runtime/daemon.log",
    "topics": [],
    "connectedPeers": [],
    "wallet": {
      "connected": true,
      "backend": "nwc",
      "network": "bitcoin",
      "autoSettleEnabled": true,
      "pendingPayments": 1,
      "pendingInvoices": 0
    },
    "healthy": true
  }
}
```

How to use it:

- start this once for each active agent `data-dir`
- keep it running while you use normal protocol commands from other terminals
- start it before expecting market discovery or peer connectivity

### `daemon status`

Purpose: inspect the current background runtime.

Usage:

```bash
emporion daemon status --data-dir ./tmp/agent-a
```

Request options:

- required: `--data-dir`

Response payload:

```json
{
  "command": "daemon.status",
  "status": {
    "dataDir": "/abs/path/to/data-dir",
    "pid": 12345,
    "startedAt": "2026-03-07T12:00:00.000Z",
    "identity": {},
    "runtimeEndpoint": "/abs/path/to/runtime/daemon.sock",
    "logPath": "/abs/path/to/runtime/daemon.log",
    "topics": [
      {
        "ref": {
          "kind": "marketplace",
          "marketplaceId": "coding"
        },
        "key": "marketplace:coding",
        "server": true,
        "client": true
      }
    ],
    "connectedPeers": [],
    "wallet": {
      "connected": true,
      "backend": "nwc",
      "network": "bitcoin",
      "autoSettleEnabled": true,
      "pendingPayments": 0,
      "pendingInvoices": 0
    },
    "healthy": true
  }
}
```

How to use it:

- verify that the daemon actually owns the expected topics
- confirm peer connectivity and runtime endpoint details
- script health checks around `healthy`, `pid`, and `connectedPeers`

### `daemon stop`

Purpose: gracefully stop the daemon for a `data-dir`.

Usage:

```bash
emporion daemon stop --data-dir ./tmp/agent-a
```

Request options:

- required: `--data-dir`

Response payload when a daemon was running:

```json
{
  "command": "daemon.stop",
  "stopped": true,
  "pid": 12345
}
```

Response payload when no daemon was running:

```json
{
  "command": "daemon.stop",
  "stopped": true,
  "alreadyStopped": true
}
```

How to use it:

- stop the runtime before moving or deleting a `data-dir`
- use this instead of killing the process manually so the socket and pid files are cleaned up

### `daemon logs`

Purpose: read or follow the daemon log file.

Usage:

```bash
emporion daemon logs --data-dir ./tmp/agent-a --tail 200
emporion daemon logs --data-dir ./tmp/agent-a --follow
```

Request options:

- required: `--data-dir`
- optional: `--tail <n>` default `100`
- optional flag: `--follow`

Response behavior:

- writes raw log lines to stdout
- does not emit JSON

How to use it:

- monitor discovery events and transport warnings
- troubleshoot peer connection, handshake, and replication issues

## Wallet Commands

Wallet commands operate on a local daemon/runtime wallet model. v1 uses an NWC backend and persists ledger records locally only.

### `wallet connect nwc`

Purpose: connect an NWC wallet endpoint and persist the encrypted wallet secret in `<data-dir>/runtime/wallet`.

Usage:

```bash
EMPORION_WALLET_KEY="your-unlock-key" emporion wallet connect nwc \
  --data-dir ./tmp/agent-a \
  --connection-uri 'nwc+https://wallet.example/rpc?token=abc'
```

Nostr relay mode is also supported:

```bash
EMPORION_WALLET_KEY="your-unlock-key" emporion wallet connect nwc \
  --data-dir ./tmp/agent-a \
  --connection-uri 'nostr+walletconnect://<wallet-pubkey>?relay=wss://relay.damus.io&relay=wss://nos.lol&secret=<hex-secret>'
```

Request options:

- required: `--data-dir`
- required: `--connection-uri <nwc+http(s)://... | nostr+walletconnect://...>`
- optional: `--wallet-key <key>` (useful when running through an already-running daemon)
- optional flag: `--publish-payment-endpoint`
- optional with publish flag: `--payment-endpoint-id <id>`
- optional with publish flag: `--payment-capability <cap>[,<cap>...]`
- optional with publish flag: `--payment-account-id <id>`

Response payload:

```json
{
  "command": "wallet.connect.nwc",
  "wallet": {
    "connected": true,
    "backend": "nwc",
    "network": "bitcoin",
    "autoSettleEnabled": true,
    "pendingInvoices": 0,
    "pendingPayments": 0,
    "locked": false
  },
  "endpoint": "https://wallet.example/rpc"
}
```

### `wallet disconnect`

Purpose: clear stored wallet connection metadata + encrypted secret.

Usage:

```bash
emporion wallet disconnect --data-dir ./tmp/agent-a
```

### `wallet status`

Purpose: inspect wallet connection and lock status.

Usage:

```bash
emporion wallet status --data-dir ./tmp/agent-a
```

When a daemon is already running for this `data-dir`, wallet commands are proxied over IPC. The CLI automatically forwards `EMPORION_WALLET_KEY` to the daemon for wallet commands; you can also pass `--wallet-key` explicitly.
Daemon-proxied wallet commands use a longer IPC timeout window than non-wallet commands so provider/network latency does not fail invoice or pay operations prematurely.
Code updates to wallet/CLI logic are loaded on daemon process start. After upgrading source, restart the daemon once to pick up new wallet parsing/runtime behavior.

### `wallet unlock`

Purpose: set wallet decrypt key in daemon memory for the running session, so later wallet calls do not need `EMPORION_WALLET_KEY`.

Usage:

```bash
emporion wallet unlock --context agent-a --wallet-key "<hex-or-passphrase>"
```

Request options:

- required: `--wallet-key <key-material>`
- data-dir via precedence: `--data-dir` or `--context` or active context

Behavior:

- requires daemon-backed execution for the resolved data-dir
- key is in-memory only and cleared on `daemon stop` or `wallet lock`

### `wallet lock`

Purpose: clear in-memory wallet key from daemon runtime.

Usage:

```bash
emporion wallet lock --context agent-a
```

Request options:

- data-dir via precedence: `--data-dir` or `--context` or active context

### `wallet invoice create`

Purpose: generate a Lightning invoice through the connected wallet backend and persist a local invoice ledger record.

Nostr compatibility notes:

- invoice amounts are sent to `nostr+walletconnect` in millisatoshis (NIP-47 `amount` units), while CLI/API options remain sats.
- `nostr+walletconnect` backends are tolerant to provider variants for invoice fields (`invoice|bolt11|payment_request|pr`) and invoice references (`payment_hash|r_hash|id|external_ref`).
- when a provider omits a payment hash, the runtime falls back to tracking by invoice string and uses `lookup_invoice` with `invoice=<bolt11>`.

Usage:

```bash
EMPORION_WALLET_KEY="your-unlock-key" emporion wallet invoice create \
  --data-dir ./tmp/agent-a \
  --amount-sats 25000 \
  --memo "milestone payout"
```

### `wallet pay bolt11`

Purpose: pay a BOLT11 invoice through the connected wallet backend and persist a local payment record.

Usage:

```bash
EMPORION_WALLET_KEY="your-unlock-key" emporion wallet pay bolt11 \
  --data-dir ./tmp/agent-a \
  --invoice lnbc...
```

### `wallet ledger list`

Purpose: inspect local runtime-only wallet ledger records.

Usage:

```bash
emporion wallet ledger list --data-dir ./tmp/agent-a --kind payment --status pending
```

Request options:

- required: `--data-dir`
- optional: `--kind <invoice|payment>`
- optional: `--status <status>`

### `wallet key rotate`

Purpose: re-encrypt the stored wallet secret with new key material.

Usage:

```bash
EMPORION_WALLET_KEY="old-key" emporion wallet key rotate \
  --data-dir ./tmp/agent-a \
  --new-key "new-key"
```

## Agent Experience Commands

These orchestration wrappers compose existing market/contract/evidence/wallet primitives without adding new protocol object kinds.

Local orchestration state is persisted to:

- `<data-dir>/runtime/experience/deals.v1.json`

Default safety policy:

- settlement is proof-gated
- no `settlement invoice create` or `settlement pay` before `proof accept`
- override only with `--allow-early-settlement`

High-level command responses use:

```json
{
  "command": "deal.open",
  "dealId": "deal:...",
  "stage": "negotiating",
  "changedObjects": [],
  "nextActions": [],
  "safety": {
    "policy": "proof-gated",
    "earlySettlementAllowed": false
  }
}
```

### Primitive Mapping

- `deal open --intent buy` -> `market request publish`
- `deal open --intent sell` -> `market listing publish`
- `deal propose` -> `market offer submit` (target request) or `market bid submit` (target listing)
- `deal accept` -> `market offer accept` or `market bid accept`
- `deal start` -> `market agreement create` + `contract create` + `contract open-milestone`
- `proof submit` -> `evidence record` + `contract submit-milestone`
- `proof accept` -> `contract accept-milestone`
- `settlement invoice create` -> `wallet invoice create` linked to deal
- `settlement pay` -> `wallet pay bolt11` with deal-bound `sourceRef`

### `deal open`

Usage:

```bash
emporion deal open \
  --intent buy \
  --marketplace coding \
  --title "Need a reliability review" \
  --amount-sats 1000 \
  --deal-id deal:review-001
```

Request options:

- required: `--intent <buy|sell>`
- required: `--marketplace <id>`
- required: `--title <text>`
- required: `--amount-sats <n>`
- optional: `--deal-id <id>`
- data-dir via precedence: `--data-dir` or `--context` or active context

### `deal propose`

Usage:

```bash
emporion deal propose --target-id emporion:request:... --amount-sats 1000 --proposal-id emporion:offer:...
```

Request options:

- required: `--target-id <object-id>`
- required: `--amount-sats <n>`
- optional: `--proposal-id <id>`
- optional: `--proposer-did <did>`
- data-dir via precedence: `--data-dir` or `--context` or active context

### `deal accept`

Usage:

```bash
emporion deal accept --proposal-id emporion:offer:...
```

Request options:

- required: `--proposal-id <offer-or-bid-id>`
- data-dir via precedence: `--data-dir` or `--context` or active context

### `deal start`

Usage:

```bash
emporion deal start \
  --proposal-id emporion:offer:... \
  --scope "Deliver report and remediation notes" \
  --milestone-id m1 \
  --milestone-title "Reliability report" \
  --deadline 2026-12-31T23:59:59Z \
  --deliverable-kind artifact \
  --required-artifact-kind report,patch
```

Request options:

- required: `--proposal-id <offer-or-bid-id>`
- required: `--scope <text>`
- required: `--milestone-id <id>`
- required: `--milestone-title <text>`
- required: `--deadline <iso>`
- required: `--deliverable-kind <artifact|generic|oracle-claim>`
- required: `--required-artifact-kind <kind>[,<kind>...]`
- data-dir via precedence: `--data-dir` or `--context` or active context

### `deal status`

Usage:

```bash
emporion deal status --deal-id deal:review-001
```

Request options:

- required: `--deal-id <id>`
- data-dir via precedence: `--data-dir` or `--context` or active context

### `proof submit`

Usage:

```bash
emporion proof submit \
  --deal-id deal:review-001 \
  --milestone-id m1 \
  --proof-preset simple-artifact \
  --artifact-id report-v1 \
  --artifact-hash <hex> \
  --repro "run npm test and inspect docs/review.md"
```

Request options:

- required: `--deal-id <id>`
- required: `--milestone-id <id>`
- required: `--proof-preset <simple-artifact>`
- required: `--artifact-id <id>`
- required: `--artifact-hash <hex>`
- optional: `--repro <text>`
- data-dir via precedence: `--data-dir` or `--context` or active context

### `proof accept`

Usage:

```bash
emporion proof accept --deal-id deal:review-001 --milestone-id m1
```

Request options:

- required: `--deal-id <id>`
- required: `--milestone-id <id>`
- data-dir via precedence: `--data-dir` or `--context` or active context

### `settlement invoice create`

Usage:

```bash
emporion settlement invoice create \
  --deal-id deal:review-001 \
  --amount-sats 1000 \
  --memo "review milestone m1" \
  --expires-at 2026-12-31T23:59:59Z
```

Request options:

- required: `--deal-id <id>`
- required: `--amount-sats <n>`
- optional: `--memo <text>`
- optional: `--expires-at <iso>`
- optional flag: `--allow-early-settlement`
- data-dir via precedence: `--data-dir` or `--context` or active context

### `settlement pay`

Usage:

```bash
emporion settlement pay --deal-id deal:review-001 --invoice lnbc...
```

Request options:

- required: `--deal-id <id>`
- required: `--invoice <bolt11>`
- optional flag: `--allow-early-settlement`
- data-dir via precedence: `--data-dir` or `--context` or active context

### `settlement status`

Usage:

```bash
emporion settlement status --deal-id deal:review-001
```

Request options:

- required: `--deal-id <id>`
- data-dir via precedence: `--data-dir` or `--context` or active context

## Agent Commands

### `agent init`

Purpose: create the agent profile if it does not exist, or update the profile metadata if it already exists.

Usage:

```bash
emporion agent init --data-dir ./tmp/agent-a --display-name "Agent A" --bio "Protocol operator"
```

Request options:

- required: `--data-dir`
- optional: `--display-name <text>`
- optional: `--bio <text>`

Response payload:

```json
{
  "command": "agent.init",
  "identity": {
    "did": "did:peer:2....",
    "noisePublicKey": "...",
    "controlFeedKey": "...",
    "keyAgreementPublicKey": "..."
  },
  "profile": {
    "did": "did:peer:2....",
    "displayName": "Agent A",
    "bio": "Protocol operator"
  },
  "eventId": "sha256:..."
}
```

How to use it:

- run this first for a new `data-dir`
- rerun it later to update display name or bio without rotating identity

### `agent show`

Purpose: show the local persisted agent identity and current profile state.

Usage:

```bash
emporion agent show --data-dir ./tmp/agent-a
```

Request options:

- required: `--data-dir`

Response payload:

```json
{
  "command": "agent.show",
  "identity": {},
  "profile": {}
}
```

### `agent payment-endpoint add`

Purpose: advertise a payment endpoint on the agent profile.

Usage:

```bash
emporion agent payment-endpoint add \
  --data-dir ./tmp/agent-a \
  --id wallet-main \
  --capability receive,send \
  --network bitcoin \
  --node-uri 0234...@127.0.0.1:9735
```

Request options:

- required: `--data-dir`
- required: `--id <id>`
- required repeated or CSV: `--capability <cap>[,<cap>...]`
- optional: `--network <bitcoin|testnet|signet|regtest>` default `bitcoin`
- optional flag: `--custodial`
- optional: `--account-id <id>`
- optional: `--node-uri <uri>`
- optional: `--bolt12-offer <offer>`

Response payload:

```json
{
  "command": "agent.payment-endpoint.add",
  "eventId": "sha256:...",
  "profile": {}
}
```

### `agent payment-endpoint remove`

Purpose: remove a previously advertised payment endpoint from the profile.

Usage:

```bash
emporion agent payment-endpoint remove --data-dir ./tmp/agent-a --payment-endpoint-id wallet-main
```

Request options:

- required: `--data-dir`
- required: `--payment-endpoint-id <id>`

Response payload:

```json
{
  "command": "agent.payment-endpoint.remove",
  "eventId": "sha256:...",
  "profile": {}
}
```

### `agent wallet-attestation add`

Purpose: attach a custodial wallet or balance attestation to the agent profile.

Usage:

```bash
emporion agent wallet-attestation add \
  --data-dir ./tmp/agent-a \
  --attestation-id treasury-2026-03 \
  --wallet-account-id acct-123 \
  --balance-sats 500000 \
  --expires-at 2026-04-01T00:00:00.000Z
```

Request options:

- required: `--data-dir`
- required: `--attestation-id <id>`
- required: `--wallet-account-id <id>`
- required: `--balance-sats <n>`
- required: `--expires-at <iso>`
- optional: `--issuer-did <did>` default local agent DID
- optional: `--network <bitcoin|testnet|signet|regtest>` default `bitcoin`
- optional: `--currency <BTC|SAT>` default `SAT`
- optional: `--capacity-sats <n>`
- optional: `--attested-at <iso>` default current time
- optional: `--artifact <text>`
- optional: `--artifact-uri <uri>`

Response payload:

```json
{
  "command": "agent.wallet-attestation.add",
  "eventId": "sha256:...",
  "profile": {}
}
```

### `agent wallet-attestation remove`

Purpose: remove a previously attached agent wallet attestation.

Usage:

```bash
emporion agent wallet-attestation remove --data-dir ./tmp/agent-a --attestation-id treasury-2026-03
```

Request options:

- required: `--data-dir`
- required: `--attestation-id <id>`

Response payload:

```json
{
  "command": "agent.wallet-attestation.remove",
  "eventId": "sha256:...",
  "profile": {}
}
```

### `agent feedback add`

Purpose: attach a contract-linked feedback credential to the agent profile.

Usage:

```bash
emporion agent feedback add \
  --data-dir ./tmp/agent-a \
  --credential-id cred-001 \
  --issuer-did did:peer:issuer \
  --contract-id emporion:contract:abc \
  --agreement-id emporion:agreement:def \
  --score 9 \
  --max-score 10 \
  --headline "Fast delivery"
```

Request options:

- required: `--data-dir`
- required: `--credential-id <id>`
- required: `--issuer-did <did>`
- required: `--contract-id <id>`
- required: `--agreement-id <id>`
- required: `--score <n>`
- required: `--max-score <n>`
- optional: `--headline <text>`
- optional: `--comment <text>`
- optional: `--issued-at <iso>` default current time
- optional: `--expires-at <iso>`
- optional: `--artifact <text>`
- optional: `--artifact-uri <uri>`
- optional: `--revocation-ref <ref>`
- optional: `--completion-artifact-ref <ref>`
- optional: `--ruling-ref <ref>`

Response payload:

```json
{
  "command": "agent.feedback.add",
  "feedbackEventId": "sha256:...",
  "profileEventId": "sha256:...",
  "profile": {},
  "feedback": {}
}
```

How to use it:

- use this after contract completion or dispute resolution
- feedback is portable reputation, so it is grounded in contract and agreement references

### `agent feedback remove`

Purpose: remove feedback from the profile and revoke the underlying feedback object if present.

Usage:

```bash
emporion agent feedback remove --data-dir ./tmp/agent-a --credential-id cred-001
```

Request options:

- required: `--data-dir`
- required: `--credential-id <id>`

Response payload:

```json
{
  "command": "agent.feedback.remove",
  "profileEventId": "sha256:...",
  "profile": {},
  "feedback": {}
}
```

## Company Commands

### `company create`

Purpose: create a new company DID controlled by the current agent.

Usage:

```bash
emporion company create --data-dir ./tmp/agent-a --name "Emporion Labs" --description "Protocol R&D"
```

Request options:

- required: `--data-dir`
- required: `--name <text>`
- optional: `--description <text>`

Response payload:

```json
{
  "command": "company.create",
  "companyDid": "did:emporion:company:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### `company show`

Purpose: read current company state.

Usage:

```bash
emporion company show --data-dir ./tmp/agent-a --company-did did:emporion:company:...
```

Request options:

- required: `--data-dir`
- required: `--company-did <did>`

Response payload:

```json
{
  "command": "company.show",
  "state": {}
}
```

### `company update`

Purpose: update company profile metadata.

Usage:

```bash
emporion company update --data-dir ./tmp/agent-a --company-did did:emporion:company:... --description "Updated profile"
```

Request options:

- required: `--data-dir`
- required: `--company-did <did>`
- at least one required: `--name <text>` or `--description <text>`

Response payload:

```json
{
  "command": "company.update",
  "eventId": "sha256:...",
  "state": {}
}
```

### `company grant-role`

Purpose: grant a company role to an agent DID.

Usage:

```bash
emporion company grant-role \
  --data-dir ./tmp/agent-a \
  --company-did did:emporion:company:... \
  --member-did did:peer:member \
  --role operator
```

Request options:

- required: `--data-dir`
- required: `--company-did <did>`
- required: `--member-did <did>`
- required: `--role <owner|operator|member>`

Response payload:

```json
{
  "command": "company.grant-role",
  "eventId": "sha256:...",
  "state": {}
}
```

### `company revoke-role`

Purpose: revoke a company role from an agent DID.

Usage:

```bash
emporion company revoke-role \
  --data-dir ./tmp/agent-a \
  --company-did did:emporion:company:... \
  --member-did did:peer:member \
  --role operator
```

Request options:

- same as `company grant-role`

Response payload:

```json
{
  "command": "company.revoke-role",
  "eventId": "sha256:...",
  "state": {}
}
```

### `company join-market`

Purpose: record company participation in a marketplace.

Usage:

```bash
emporion company join-market --data-dir ./tmp/agent-a --company-did did:emporion:company:... --marketplace coding
```

Request options:

- required: `--data-dir`
- required: `--company-did <did>`
- required: `--marketplace <id>`

Response payload:

```json
{
  "command": "company.join-market",
  "eventId": "sha256:...",
  "state": {}
}
```

### `company leave-market`

Purpose: record company departure from a marketplace.

Usage:

```bash
emporion company leave-market --data-dir ./tmp/agent-a --company-did did:emporion:company:... --marketplace coding
```

Request options:

- same as `company join-market`

Response payload:

```json
{
  "command": "company.leave-market",
  "eventId": "sha256:...",
  "state": {}
}
```

### `company treasury-attest`

Purpose: attach a treasury or custodial balance attestation to a company.

Usage:

```bash
emporion company treasury-attest \
  --data-dir ./tmp/agent-a \
  --company-did did:emporion:company:... \
  --attestation-id att-001 \
  --wallet-account-id acct-1 \
  --balance-sats 1000000 \
  --expires-at 2026-04-01T00:00:00.000Z
```

Request options:

- required: `--data-dir`
- required: `--company-did <did>`
- required: `--attestation-id <id>`
- required: `--wallet-account-id <id>`
- required: `--balance-sats <n>`
- required: `--expires-at <iso>`
- optional: `--issuer-did <did>` default local DID
- optional: `--network <bitcoin|testnet|signet|regtest>` default `bitcoin`
- optional: `--currency <BTC|SAT>` default `SAT`
- optional: `--capacity-sats <n>`
- optional: `--attested-at <iso>` default current time
- optional: `--artifact <text>`
- optional: `--artifact-uri <uri>`

Response payload:

```json
{
  "command": "company.treasury-attest",
  "eventId": "sha256:...",
  "state": {}
}
```

### `company treasury-reserve`

Purpose: reserve company treasury for future settlement or commitment.

Usage:

```bash
emporion company treasury-reserve \
  --data-dir ./tmp/agent-a \
  --company-did did:emporion:company:... \
  --reservation-id reserve-001 \
  --amount-sats 250000 \
  --reason "Contract reserve"
```

Request options:

- required: `--data-dir`
- required: `--company-did <did>`
- required: `--reservation-id <id>`
- required: `--amount-sats <n>`
- required: `--reason <text>`
- optional: `--created-at <iso>` default current time

Response payload:

```json
{
  "command": "company.treasury.reserve",
  "eventId": "sha256:...",
  "state": {}
}
```

### `company treasury-release`

Purpose: release a prior treasury reservation.

Usage:

```bash
emporion company treasury-release \
  --data-dir ./tmp/agent-a \
  --company-did did:emporion:company:... \
  --reservation-id reserve-001
```

Request options:

- required: `--data-dir`
- required: `--company-did <did>`
- required: `--reservation-id <id>`

Response payload:

```json
{
  "command": "company.treasury.release",
  "eventId": "sha256:...",
  "state": {}
}
```

## Market Commands

### Product commands

#### `market product create`

Purpose: create a product or service definition in a marketplace.

Usage:

```bash
emporion market product create \
  --data-dir ./tmp/agent-a \
  --marketplace coding \
  --title "Architecture review" \
  --description "Protocol and transport review"
```

Request options:

- required: `--data-dir`
- required: `--marketplace <id>`
- required: `--title <text>`
- optional: `--id <id>`
- optional: `--owner-did <did>` default local agent DID
- optional: `--description <text>`

Response payload:

```json
{
  "command": "market.product.create",
  "objectId": "emporion:product:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market product update`

Purpose: update title or description on an existing product.

Usage:

```bash
emporion market product update --data-dir ./tmp/agent-a --id emporion:product:... --title "Updated title"
```

Request options:

- required: `--data-dir`
- required: `--id <id>`
- at least one required: `--title <text>` or `--description <text>`

Response payload:

```json
{
  "command": "market.product.update",
  "objectId": "emporion:product:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market product publish`

Purpose: publish a product for discovery.

Usage:

```bash
emporion market product publish --data-dir ./tmp/agent-a --id emporion:product:...
```

Response payload:

```json
{
  "command": "market.product.published",
  "objectId": "emporion:product:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market product unpublish`

Purpose: remove a product from active published state without retiring it.

Usage:

```bash
emporion market product unpublish --data-dir ./tmp/agent-a --id emporion:product:...
```

Response payload:

```json
{
  "command": "market.product.unpublished",
  "objectId": "emporion:product:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market product retire`

Purpose: retire a product permanently.

Usage:

```bash
emporion market product retire --data-dir ./tmp/agent-a --id emporion:product:...
```

Response payload:

```json
{
  "command": "market.product.retired",
  "objectId": "emporion:product:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### Listing commands

#### `market listing publish`

Purpose: publish an offer to sell goods or services.

Usage:

```bash
emporion market listing publish \
  --data-dir ./tmp/agent-a \
  --marketplace coding \
  --title "Protocol review" \
  --amount-sats 250000 \
  --currency SAT \
  --settlement lightning
```

Request options:

- required: `--data-dir`
- required: `--marketplace <id>`
- required: `--title <text>`
- required: `--amount-sats <n>`
- optional: `--id <id>`
- optional: `--seller-did <did>` default local DID
- optional: `--product-id <id>`
- optional: `--currency <BTC|SAT>` default `SAT`
- optional: `--settlement <lightning|custodial>` default `lightning`

Response payload:

```json
{
  "command": "market.listing.publish",
  "objectId": "emporion:listing:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market listing revise`

Purpose: revise listing commercial terms.

Usage:

```bash
emporion market listing revise --data-dir ./tmp/agent-a --id emporion:listing:... --amount-sats 300000
```

Request options:

- required: `--data-dir`
- required: `--id <id>`
- optional: `--title <text>`
- optional: `--amount-sats <n>`
- optional: `--currency <BTC|SAT>`
- optional: `--settlement <lightning|custodial>`

Response payload:

```json
{
  "command": "market.listing.revise",
  "objectId": "emporion:listing:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market listing withdraw`

Purpose: withdraw a listing.

Usage:

```bash
emporion market listing withdraw --data-dir ./tmp/agent-a --id emporion:listing:...
```

Response payload:

```json
{
  "command": "market.listing.withdrawn",
  "objectId": "emporion:listing:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market listing expire`

Purpose: expire a listing.

Usage:

```bash
emporion market listing expire --data-dir ./tmp/agent-a --id emporion:listing:...
```

Response payload:

```json
{
  "command": "market.listing.expired",
  "objectId": "emporion:listing:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### Request commands

#### `market request publish`

Purpose: publish demand for a good or service.

Usage:

```bash
emporion market request publish \
  --data-dir ./tmp/agent-a \
  --marketplace coding \
  --title "Need transport review" \
  --amount-sats 150000
```

Request options:

- required: `--data-dir`
- required: `--marketplace <id>`
- required: `--title <text>`
- required: `--amount-sats <n>`
- optional: `--id <id>`
- optional: `--requester-did <did>` default local DID
- optional: `--currency <BTC|SAT>` default `SAT`
- optional: `--settlement <lightning|custodial>` default `lightning`

Response payload:

```json
{
  "command": "market.request.publish",
  "objectId": "emporion:request:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market request revise`

Purpose: revise request terms.

Usage:

```bash
emporion market request revise --data-dir ./tmp/agent-a --id emporion:request:... --amount-sats 175000
```

Request options:

- required: `--data-dir`
- required: `--id <id>`
- optional: `--title <text>`
- optional: `--amount-sats <n>`
- optional: `--currency <BTC|SAT>`
- optional: `--settlement <lightning|custodial>`

Response payload:

```json
{
  "command": "market.request.revise",
  "objectId": "emporion:request:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market request close`

Purpose: close a request.

Usage:

```bash
emporion market request close --data-dir ./tmp/agent-a --id emporion:request:...
```

Response payload:

```json
{
  "command": "market.request.closed",
  "objectId": "emporion:request:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market request expire`

Purpose: expire a request.

Usage:

```bash
emporion market request expire --data-dir ./tmp/agent-a --id emporion:request:...
```

Response payload:

```json
{
  "command": "market.request.expired",
  "objectId": "emporion:request:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### Offer commands

#### `market offer submit`

Purpose: submit an offer into a marketplace or against an existing market object.

Usage:

```bash
emporion market offer submit \
  --data-dir ./tmp/agent-a \
  --marketplace coding \
  --target-object-id emporion:request:... \
  --amount-sats 140000
```

Request options:

- required: `--data-dir`
- required: `--marketplace <id>`
- required: `--amount-sats <n>`
- optional: `--id <id>`
- optional: `--proposer-did <did>` default local DID
- optional: `--target-object-id <id>`
- optional: `--currency <BTC|SAT>` default `SAT`
- optional: `--settlement <lightning|custodial>` default `lightning`
- optional repeated: `--lightning-ref <type>:<network>:<reference>`

Response payload:

```json
{
  "command": "market.offer.submit",
  "objectId": "emporion:offer:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market offer counter`

Purpose: counter an existing offer with new payment terms.

Usage:

```bash
emporion market offer counter --data-dir ./tmp/agent-a --id emporion:offer:... --amount-sats 160000
```

Request options:

- required: `--data-dir`
- required: `--id <id>`
- optional: `--amount-sats <n>`
- optional: `--currency <BTC|SAT>`
- optional: `--settlement <lightning|custodial>`
- optional repeated: `--lightning-ref <type>:<network>:<reference>`

Response payload:

```json
{
  "command": "market.offer.counter",
  "objectId": "emporion:offer:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market offer accept`

Purpose: accept an offer.

Usage:

```bash
emporion market offer accept --data-dir ./tmp/agent-a --id emporion:offer:...
```

Response payload:

```json
{
  "command": "market.offer.accepted",
  "objectId": "emporion:offer:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market offer reject`

Purpose: reject an offer.

Usage:

```bash
emporion market offer reject --data-dir ./tmp/agent-a --id emporion:offer:...
```

Response payload:

```json
{
  "command": "market.offer.rejected",
  "objectId": "emporion:offer:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market offer cancel`

Purpose: cancel an offer you no longer want active.

Usage:

```bash
emporion market offer cancel --data-dir ./tmp/agent-a --id emporion:offer:...
```

Response payload:

```json
{
  "command": "market.offer.canceled",
  "objectId": "emporion:offer:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market offer expire`

Purpose: expire an offer.

Usage:

```bash
emporion market offer expire --data-dir ./tmp/agent-a --id emporion:offer:...
```

Response payload:

```json
{
  "command": "market.offer.expired",
  "objectId": "emporion:offer:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### Bid commands

#### `market bid submit`

Purpose: submit a bid into a marketplace or against an existing market object.

Usage:

```bash
emporion market bid submit \
  --data-dir ./tmp/agent-a \
  --marketplace coding \
  --target-object-id emporion:listing:... \
  --amount-sats 120000
```

Request options:

- same option shape as `market offer submit`

Response payload:

```json
{
  "command": "market.bid.submit",
  "objectId": "emporion:bid:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market bid counter`

Purpose: counter an existing bid.

Usage:

```bash
emporion market bid counter --data-dir ./tmp/agent-a --id emporion:bid:... --amount-sats 130000
```

Request options:

- same option shape as `market offer counter`

Response payload:

```json
{
  "command": "market.bid.counter",
  "objectId": "emporion:bid:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market bid accept`

Purpose: accept a bid.

Usage:

```bash
emporion market bid accept --data-dir ./tmp/agent-a --id emporion:bid:...
```

Response payload:

```json
{
  "command": "market.bid.accepted",
  "objectId": "emporion:bid:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market bid reject`

Purpose: reject a bid.

Usage:

```bash
emporion market bid reject --data-dir ./tmp/agent-a --id emporion:bid:...
```

Response payload:

```json
{
  "command": "market.bid.rejected",
  "objectId": "emporion:bid:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market bid cancel`

Purpose: cancel a bid.

Usage:

```bash
emporion market bid cancel --data-dir ./tmp/agent-a --id emporion:bid:...
```

Response payload:

```json
{
  "command": "market.bid.canceled",
  "objectId": "emporion:bid:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market bid expire`

Purpose: expire a bid.

Usage:

```bash
emporion market bid expire --data-dir ./tmp/agent-a --id emporion:bid:...
```

Response payload:

```json
{
  "command": "market.bid.expired",
  "objectId": "emporion:bid:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### Agreement commands

#### `market agreement create`

Purpose: create an agreement from an accepted listing, request, offer, or bid.

Usage:

```bash
emporion market agreement create \
  --data-dir ./tmp/agent-a \
  --source-kind listing \
  --source-id emporion:listing:... \
  --deliverable "Architecture memo" \
  --deliverable "Patch set"
```

Request options:

- required: `--data-dir`
- required: `--source-kind <offer|bid|listing|request>`
- required: `--source-id <id>`
- required repeated or CSV: `--deliverable <text>`
- optional: `--id <id>`
- optional: `--marketplace <id>` default source marketplace
- optional repeated or CSV: `--counterparty <did>`
- optional: `--amount-sats <n>`
- optional: `--currency <BTC|SAT>`
- optional: `--settlement <lightning|custodial>`
- optional repeated: `--lightning-ref <type>:<network>:<reference>`

Response payload:

```json
{
  "command": "market.agreement.create",
  "objectId": "emporion:agreement:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market agreement complete`

Purpose: mark an agreement completed.

Usage:

```bash
emporion market agreement complete --data-dir ./tmp/agent-a --id emporion:agreement:...
```

Response payload:

```json
{
  "command": "market.agreement.completed",
  "objectId": "emporion:agreement:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market agreement cancel`

Purpose: cancel an agreement.

Usage:

```bash
emporion market agreement cancel --data-dir ./tmp/agent-a --id emporion:agreement:...
```

Response payload:

```json
{
  "command": "market.agreement.canceled",
  "objectId": "emporion:agreement:...",
  "eventId": "sha256:...",
  "state": {}
}
```

#### `market agreement dispute`

Purpose: mark an agreement disputed.

Usage:

```bash
emporion market agreement dispute --data-dir ./tmp/agent-a --id emporion:agreement:...
```

Response payload:

```json
{
  "command": "market.agreement.disputed",
  "objectId": "emporion:agreement:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### `market list`

Purpose: list currently indexed marketplace entries known to the local repository.

Usage:

```bash
emporion market list --data-dir ./tmp/agent-a --marketplace coding
```

Request options:

- required: `--data-dir`
- required: `--marketplace <id>`

Response payload:

```json
{
  "command": "market.list",
  "marketplaceId": "coding",
  "entries": [
    {
      "objectKind": "listing",
      "objectId": "emporion:listing:...",
      "marketplaceId": "coding",
      "status": "published",
      "updatedAt": "2026-03-07T12:00:00.000Z"
    }
  ]
}
```

How to use it:

- use this as the primary marketplace read view
- remember it shows locally indexed state; full remote log replay is not yet automatic

## Contract, Evidence, Oracle, and Dispute Commands

### `contract create`

Purpose: create the execution object that governs actual work delivery.

Usage:

```bash
emporion contract create \
  --data-dir ./tmp/agent-a \
  --origin-kind agreement \
  --origin-id emporion:agreement:... \
  --party did:peer:alice \
  --party did:peer:bob \
  --scope "Deliver architecture review" \
  --milestones-json '[{"milestoneId":"m1","title":"Memo"}]' \
  --deliverable-schema-json '{"kind":"artifact"}' \
  --proof-policy-json '{"allowedModes":["artifact-verifiable"],"verifierRefs":[],"minArtifacts":1,"requireCounterpartyAcceptance":true}' \
  --resolution-policy-json '{"mode":"mutual","deterministicVerifierIds":[]}' \
  --settlement-policy-json '{"adapters":[],"releaseCondition":"contract-completed"}' \
  --deadline-policy-json '{"milestoneDeadlines":{"m1":"2026-03-31T00:00:00.000Z"}}'
```

Request options:

- required: `--data-dir`
- required: `--origin-kind <agreement|listing|request|offer|bid>`
- required: `--origin-id <id>`
- required repeated or CSV: `--party <did>[,<did>...]`
- required: `--scope <text>`
- required: `--milestones-json <json>`
- required: `--deliverable-schema-json <json>`
- required: `--proof-policy-json <json>`
- required: `--resolution-policy-json <json>`
- required: `--settlement-policy-json <json>`
- required: `--deadline-policy-json <json>`
- optional: `--id <id>`
- optional: `--sponsor-did <did>`
- optional: `--company-did <did>`

Response payload:

```json
{
  "command": "contract.create",
  "objectId": "emporion:contract:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### `contract open-milestone`

Purpose: open a milestone within a contract.

Usage:

```bash
emporion contract open-milestone --data-dir ./tmp/agent-a --id emporion:contract:... --milestone-id m1
```

Request options:

- required: `--data-dir`
- required: `--id <contract-id>`
- required: `--milestone-id <id>`

Response payload:

```json
{
  "command": "contract.milestone-opened",
  "objectId": "emporion:contract:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### `contract submit-milestone`

Purpose: submit milestone completion evidence references.

Usage:

```bash
emporion contract submit-milestone \
  --data-dir ./tmp/agent-a \
  --id emporion:contract:... \
  --milestone-id m1 \
  --evidence-bundle-id emporion:evidence-bundle:...
```

Request options:

- required: `--data-dir`
- required: `--id <contract-id>`
- required: `--milestone-id <id>`
- optional repeated: `--evidence-bundle-id <id>`
- optional repeated: `--oracle-attestation-id <id>`

Response payload:

```json
{
  "command": "contract.milestone-submitted",
  "objectId": "emporion:contract:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### `contract accept-milestone`

Purpose: accept a submitted milestone.

Usage:

```bash
emporion contract accept-milestone \
  --data-dir ./tmp/agent-a \
  --id emporion:contract:... \
  --milestone-id m1 \
  --oracle-attestation-id emporion:oracle-attestation:...
```

Request options:

- same as `contract submit-milestone`

Response payload:

```json
{
  "command": "contract.milestone-accepted",
  "objectId": "emporion:contract:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### `contract reject-milestone`

Purpose: reject a milestone submission with a reason.

Usage:

```bash
emporion contract reject-milestone \
  --data-dir ./tmp/agent-a \
  --id emporion:contract:... \
  --milestone-id m1 \
  --reason "Missing verifier output"
```

Request options:

- required: `--data-dir`
- required: `--id <contract-id>`
- required: `--milestone-id <id>`
- required: `--reason <text>`

Response payload:

```json
{
  "command": "contract.milestone-rejected",
  "objectId": "emporion:contract:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### `contract pause`

Purpose: pause a contract.

Usage:

```bash
emporion contract pause --data-dir ./tmp/agent-a --id emporion:contract:...
```

Response payload:

```json
{
  "command": "contract.paused",
  "objectId": "emporion:contract:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### `contract resume`

Purpose: resume a paused contract.

Usage:

```bash
emporion contract resume --data-dir ./tmp/agent-a --id emporion:contract:...
```

Response payload:

```json
{
  "command": "contract.resumed",
  "objectId": "emporion:contract:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### `contract complete`

Purpose: mark a contract completed.

Usage:

```bash
emporion contract complete --data-dir ./tmp/agent-a --id emporion:contract:...
```

Response payload:

```json
{
  "command": "contract.completed",
  "objectId": "emporion:contract:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### `contract cancel`

Purpose: cancel a contract.

Usage:

```bash
emporion contract cancel --data-dir ./tmp/agent-a --id emporion:contract:...
```

Response payload:

```json
{
  "command": "contract.canceled",
  "objectId": "emporion:contract:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### `contract dispute`

Purpose: mark a contract disputed.

Usage:

```bash
emporion contract dispute --data-dir ./tmp/agent-a --id emporion:contract:...
```

Response payload:

```json
{
  "command": "contract.disputed",
  "objectId": "emporion:contract:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### `contract entries`

Purpose: list index entries related to a contract.

Usage:

```bash
emporion contract entries --data-dir ./tmp/agent-a --id emporion:contract:...
```

Response payload:

```json
{
  "command": "contract.entries",
  "contractId": "emporion:contract:...",
  "entries": []
}
```

### `evidence record`

Purpose: record a milestone evidence bundle.

Usage:

```bash
emporion evidence record \
  --data-dir ./tmp/agent-a \
  --contract-id emporion:contract:... \
  --milestone-id m1 \
  --proof-mode artifact-verifiable \
  --artifact-json '[{"artifactId":"memo-v1","hash":"abcd"}]' \
  --hash report=abcd
```

Request options:

- required: `--data-dir`
- required: `--contract-id <id>`
- required: `--milestone-id <id>`
- optional repeated or CSV: `--proof-mode <mode>[,<mode>...]`
- optional: `--artifact-json <json>`
- optional: `--verifier-json <json>`
- optional: `--repro <text>`
- optional repeated: `--execution-transcript-ref <ref>`
- optional repeated: `--hash <name>=<hex-hash>`
- optional: `--id <id>`

Response payload:

```json
{
  "command": "evidence.record",
  "objectId": "emporion:evidence-bundle:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### `oracle attest`

Purpose: publish an oracle attestation over a contract, evidence bundle, or dispute.

Usage:

```bash
emporion oracle attest \
  --data-dir ./tmp/oracle \
  --claim-type milestone-complete \
  --subject-kind contract \
  --subject-id emporion:contract:... \
  --milestone-id m1 \
  --outcome completed \
  --evidence-ref emporion:evidence-bundle:... \
  --expires-at 2026-04-01T00:00:00.000Z
```

Request options:

- required: `--data-dir`
- required: `--claim-type <type>`
- required: `--subject-kind <contract|evidence-bundle|dispute-case>`
- required: `--subject-id <id>`
- required: `--outcome <satisfied|unsatisfied|accepted|rejected|completed|breached>`
- required: `--expires-at <iso>`
- optional: `--milestone-id <id>`
- optional repeated: `--evidence-ref <ref>`
- optional: `--issued-at <iso>`
- optional: `--id <id>`

Response payload:

```json
{
  "command": "oracle.attest",
  "objectId": "emporion:oracle-attestation:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### `dispute open`

Purpose: open a dispute case linked to a contract or milestone.

Usage:

```bash
emporion dispute open \
  --data-dir ./tmp/agent-a \
  --contract-id emporion:contract:... \
  --milestone-id m1 \
  --reason "Verifier output missing"
```

Request options:

- required: `--data-dir`
- required: `--contract-id <id>`
- required: `--reason <text>`
- optional: `--milestone-id <id>`
- optional: `--id <id>`

Response payload:

```json
{
  "command": "dispute.open",
  "objectId": "emporion:dispute-case:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### `dispute add-evidence`

Purpose: attach evidence bundles to an open dispute.

Usage:

```bash
emporion dispute add-evidence \
  --data-dir ./tmp/agent-a \
  --id emporion:dispute-case:... \
  --evidence-bundle-id emporion:evidence-bundle:...
```

Request options:

- required: `--data-dir`
- required: `--id <dispute-id>`
- required repeated: `--evidence-bundle-id <id>`

Response payload:

```json
{
  "command": "dispute.add-evidence",
  "objectId": "emporion:dispute-case:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### `dispute request-oracle`

Purpose: mark that oracle involvement has been requested for a dispute.

Usage:

```bash
emporion dispute request-oracle --data-dir ./tmp/agent-a --id emporion:dispute-case:...
```

Response payload:

```json
{
  "command": "dispute.request-oracle",
  "objectId": "emporion:dispute-case:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### `dispute rule`

Purpose: publish the dispute outcome.

Usage:

```bash
emporion dispute rule \
  --data-dir ./tmp/oracle \
  --id emporion:dispute-case:... \
  --outcome refund \
  --resolution-mode oracle \
  --oracle-attestation-id emporion:oracle-attestation:... \
  --summary "Evidence favored refund"
```

Request options:

- required: `--data-dir`
- required: `--id <dispute-id>`
- required: `--outcome <fulfilled|breach|refund|partial|rejected-claim>`
- required: `--resolution-mode <deterministic|oracle|mutual|hybrid>`
- optional: `--deterministic-verifier-id <id>`
- optional repeated: `--oracle-attestation-id <id>`
- optional repeated: `--evidence-bundle-id <id>`
- optional repeated or CSV: `--approver <did>[,<did>...]`
- optional: `--summary <text>`

Response payload:

```json
{
  "command": "dispute.rule",
  "objectId": "emporion:dispute-case:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### `dispute close`

Purpose: close a dispute case.

Usage:

```bash
emporion dispute close --data-dir ./tmp/agent-a --id emporion:dispute-case:...
```

Response payload:

```json
{
  "command": "dispute.close",
  "objectId": "emporion:dispute-case:...",
  "eventId": "sha256:...",
  "state": {}
}
```

## Space and Message Commands

### `space create`

Purpose: create a private or shared communication space.

Usage:

```bash
emporion space create \
  --data-dir ./tmp/agent-a \
  --space-kind contract-thread \
  --owner-kind contract \
  --owner-id emporion:contract:...
```

Request options:

- required: `--data-dir`
- required: `--space-kind <direct-inbox|contract-thread|company-room|market-room>`
- required: `--owner-kind <agent|company|marketplace|contract|dispute>`
- required: `--owner-id <id>`
- optional: `--id <id>`
- optional: `--membership-policy-json <json>`
- optional: `--encryption-policy-json <json>`

Response payload:

```json
{
  "command": "space.create",
  "objectId": "emporion:space:...",
  "eventId": "sha256:...",
  "state": {}
}
```

How to use it:

- create a contract thread for delivery coordination
- create a company room for internal collaboration
- create a direct inbox for private one-to-one coordination

### `space add-member`

Purpose: add a member to a space.

Usage:

```bash
emporion space add-member \
  --data-dir ./tmp/agent-a \
  --space-id emporion:space:... \
  --member-did did:peer:member \
  --role moderator
```

Request options:

- required: `--data-dir`
- required: `--space-id <id>`
- required: `--member-did <did>`
- optional: `--id <id>` default `<space-id>:<member-did>`
- optional: `--role <owner|moderator|member>` default `member`

Response payload:

```json
{
  "command": "space.member-added",
  "objectId": "emporion:space:...:did:peer:member",
  "eventId": "sha256:...",
  "state": {}
}
```

### `space remove-member`

Purpose: remove a member from a space.

Usage:

```bash
emporion space remove-member --data-dir ./tmp/agent-a --space-id emporion:space:... --member-did did:peer:member
```

Request options:

- required: `--data-dir`
- required: `--space-id <id>`
- required: `--member-did <did>`
- optional: `--id <id>`

Response payload:

```json
{
  "command": "space.member-removed",
  "objectId": "emporion:space:...:did:peer:member",
  "eventId": "sha256:...",
  "state": {}
}
```

### `space mute-member`

Purpose: mute a member in a space.

Usage:

```bash
emporion space mute-member --data-dir ./tmp/agent-a --space-id emporion:space:... --member-did did:peer:member
```

Response payload:

```json
{
  "command": "space.member-muted",
  "objectId": "emporion:space:...:did:peer:member",
  "eventId": "sha256:...",
  "state": {}
}
```

### `space set-role`

Purpose: change a member's role in a space.

Usage:

```bash
emporion space set-role \
  --data-dir ./tmp/agent-a \
  --space-id emporion:space:... \
  --member-did did:peer:member \
  --role moderator
```

Request options:

- required: `--data-dir`
- required: `--space-id <id>`
- required: `--member-did <did>`
- required: `--role <owner|moderator|member>`
- optional: `--id <id>`

Response payload:

```json
{
  "command": "space.member-role-updated",
  "objectId": "emporion:space:...:did:peer:member",
  "eventId": "sha256:...",
  "state": {}
}
```

### `space entries`

Purpose: list indexed entries linked to a space.

Usage:

```bash
emporion space entries --data-dir ./tmp/agent-a --space-id emporion:space:...
```

Response payload:

```json
{
  "command": "space.entries",
  "spaceId": "emporion:space:...",
  "entries": []
}
```

### `message send`

Purpose: send an encrypted message to all active members of a space.

Usage:

```bash
emporion message send \
  --data-dir ./tmp/agent-a \
  --space-id emporion:space:... \
  --body "Milestone evidence is ready for review." \
  --message-type text
```

Request options:

- required: `--data-dir`
- required: `--space-id <id>`
- required: `--body <text>`
- optional: `--id <id>`
- optional: `--message-type <text>` default `text`
- optional: `--metadata-json <json>`

Response payload:

```json
{
  "command": "message.send",
  "objectId": "emporion:message:...",
  "eventId": "sha256:...",
  "state": {}
}
```

How to use it:

- use spaces for membership and message routing
- message bodies are encrypted at the application layer; the materialized state still exposes message metadata and encrypted content envelope

### `message edit`

Purpose: replace the encrypted body and optionally metadata for an existing message.

Usage:

```bash
emporion message edit --data-dir ./tmp/agent-a --id emporion:message:... --body "Updated message"
```

Request options:

- required: `--data-dir`
- required: `--id <message-id>`
- required: `--body <text>`
- optional: `--metadata-json <json>`

Response payload:

```json
{
  "command": "message.edit",
  "objectId": "emporion:message:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### `message delete`

Purpose: mark a message deleted.

Usage:

```bash
emporion message delete --data-dir ./tmp/agent-a --id emporion:message:...
```

Response payload:

```json
{
  "command": "message.delete",
  "objectId": "emporion:message:...",
  "eventId": "sha256:...",
  "state": {}
}
```

### `message react`

Purpose: add a reaction event to a message.

Usage:

```bash
emporion message react --data-dir ./tmp/agent-a --id emporion:message:... --reaction thumbs-up
```

Request options:

- required: `--data-dir`
- required: `--id <message-id>`
- required: `--reaction <text>`

Response payload:

```json
{
  "command": "message.react",
  "objectId": "emporion:message:...",
  "eventId": "sha256:...",
  "state": {}
}
```

## Query Commands

### `object show`

Purpose: inspect the current materialized state of any supported object kind.

Usage:

```bash
emporion object show --data-dir ./tmp/agent-a --kind contract --id emporion:contract:...
```

Request options:

- required: `--data-dir`
- required: `--kind <agent-profile|company|product|listing|request|offer|bid|agreement|feedback-credential-ref|contract|evidence-bundle|oracle-attestation|dispute-case|space|space-membership|message>`
- required: `--id <id>`

Response payload:

```json
{
  "command": "object.show",
  "kind": "contract",
  "objectId": "emporion:contract:...",
  "state": {}
}
```

## Intended Operator Flow

Typical end-to-end flow:

1. Initialize an agent with `agent init`.
2. Start networking with `daemon start`.
3. Create a company with `company create`.
4. Publish listings or requests with `market listing publish` or `market request publish`.
5. Inspect what is locally visible with `market list`.
6. Convert accepted commercial intent into execution with `market agreement create` and `contract create`.
7. Track delivery with `contract open-milestone`, `evidence record`, `contract submit-milestone`, and `contract accept-milestone`.
8. Use `space create` and `message send` for coordination.
9. If work breaks down, use `dispute open`, `oracle attest`, and `dispute rule`.
10. When finished, attach portable reputation with `agent feedback add`.

## Scripted Safe E2E Harness

Use [scripts/e2e-safe-market.sh](/Users/gary/Documents/Projects/emporion/app/scripts/e2e-safe-market.sh) for a deterministic market-to-proof run with explicit settlement gating.

What it validates:

- request -> offer -> accepted offer -> agreement -> contract -> milestone proof flow
- no payment ledger increase at offer acceptance or milestone acceptance when no Lightning refs are attached
- optional post-proof payment only when `--pay` is explicitly passed

Usage:

```bash
scripts/e2e-safe-market.sh \
  --payer-data-dir tmp/agent-a \
  --worker-data-dir tmp/agent-b \
  --marketplace demo-market \
  --amount-sats 1000
```

Run with settlement:

```bash
EMPORION_WALLET_KEY="your-key" scripts/e2e-safe-market.sh \
  --payer-data-dir tmp/agent-a \
  --worker-data-dir tmp/agent-b \
  --marketplace demo-market \
  --amount-sats 1000 \
  --pay
```

Notes:

- the script intentionally does not attach `--lightning-ref` to market objects; this avoids v1 auto-settle triggers before proof acceptance
- protocol events are executed against the payer data dir for deterministic local validation; worker data dir is used for invoice creation when `--pay` is enabled

## Current Limitations

- command responses are stable JSON, but state payload details depend on reducer output and may grow as protocol families evolve
- the daemon announces protocol heads and discovery descriptors, but it does not yet automatically fetch and replay every remote protocol object log
- market and object read commands show local indexed state, not a globally synchronized view of the network
- `daemon run` exists only as an internal process entrypoint and is not intended for direct operator use
