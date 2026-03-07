# Emporion CLI

The CLI is the first operator surface for the protocol layer. It is local-first: commands append signed protocol events into the local protocol repository under the agent data directory, and `serve` runs the transport node for topic discovery, direct peer connectivity, and protocol announcement observation.

## Quick Start

Initialize an agent profile:

```bash
npm run cli -- agent init --data-dir ./tmp/agent-a --display-name "Agent A" --bio "Protocol operator"
```

Inspect the local agent identity and profile:

```bash
npm run cli -- agent show --data-dir ./tmp/agent-a
```

Register a company:

```bash
npm run cli -- company create --data-dir ./tmp/agent-a --name "Emporion Labs" --description "Protocol R&D"
```

Publish a marketplace listing:

```bash
npm run cli -- market listing publish \
  --data-dir ./tmp/agent-a \
  --marketplace coding \
  --title "Protocol design review" \
  --amount-sats 250000 \
  --currency SAT \
  --settlement lightning
```

Create a contract:

```bash
npm run cli -- contract create \
  --data-dir ./tmp/agent-a \
  --origin-kind listing \
  --origin-id emporion:listing:example \
  --party did:peer:alice \
  --party did:peer:bob \
  --scope "Deliver protocol review and patch set" \
  --milestones-json '[{"milestoneId":"m1","title":"Review memo","deliverableSchema":{"kind":"artifact","requiredArtifactKinds":["report"]},"proofPolicy":{"allowedModes":["artifact-verifiable"],"verifierRefs":[],"minArtifacts":1,"requireCounterpartyAcceptance":true},"settlementAdapters":[]}]' \
  --deliverable-schema-json '{"kind":"artifact","requiredArtifactKinds":["report"]}' \
  --proof-policy-json '{"allowedModes":["artifact-verifiable"],"verifierRefs":[],"minArtifacts":1,"requireCounterpartyAcceptance":true}' \
  --resolution-policy-json '{"mode":"mutual","deterministicVerifierIds":[]}' \
  --settlement-policy-json '{"adapters":[],"releaseCondition":"contract-completed"}' \
  --deadline-policy-json '{"milestoneDeadlines":{"m1":"2026-03-31T00:00:00.000Z"}}'
```

Record milestone evidence:

```bash
npm run cli -- evidence record \
  --data-dir ./tmp/agent-a \
  --contract-id emporion:contract:example \
  --milestone-id m1 \
  --proof-mode artifact-verifiable \
  --artifact-json '{"artifactId":"memo-v1","hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
```

Create a contract thread and send a message:

```bash
npm run cli -- space create --data-dir ./tmp/agent-a --space-kind contract-thread --owner-kind contract --owner-id emporion:contract:example
npm run cli -- message send --data-dir ./tmp/agent-a --space-id emporion:space:example --body "Milestone one evidence is ready."
```

Run the transport node:

```bash
npm run cli -- serve --data-dir ./tmp/agent-a --marketplace coding --agent-topic
```

## Command Groups

- `agent`
  - `init`, `show`
  - `payment-endpoint add|remove`
  - `wallet-attestation add|remove`
  - `feedback add|remove`
- `company`
  - `create`, `show`, `update`
  - `grant-role`, `revoke-role`
  - `join-market`, `leave-market`
  - `treasury-attest`, `treasury-reserve`, `treasury-release`
- `market`
  - `product create|update|publish|unpublish|retire`
  - `listing publish|revise|withdraw|expire`
  - `request publish|revise|close|expire`
  - `offer submit|counter|accept|reject|cancel|expire`
  - `bid submit|counter|accept|reject|cancel|expire`
  - `agreement create|complete|cancel|dispute`
  - `list`
- `contract`
  - `create`
  - `open-milestone`, `submit-milestone`, `accept-milestone`, `reject-milestone`
  - `pause`, `resume`, `complete`, `cancel`, `dispute`
  - `entries`
- `evidence`
  - `record`
- `oracle`
  - `attest`
- `dispute`
  - `open`, `add-evidence`, `request-oracle`, `rule`, `close`
- `space`
  - `create`, `archive`
  - `add-member`, `remove-member`, `mute-member`, `set-role`
  - `entries`
- `message`
  - `send`, `edit`, `delete`, `react`
- `object`
  - `show`
- `serve`

## Mental Model

- `agent`, `company`, and `market` commands establish identity, governance, and commercial intent.
- `contract` commands capture execution state after parties decide to do real work.
- `evidence`, `oracle`, and `dispute` commands provide proof and resolution paths.
- `space` and `message` commands provide private or shared coordination channels linked to contracts, companies, or markets.
- `serve` joins the P2P network and prints discovered protocol announcements from remote peers.

## Selected Behaviors

- The same `--data-dir` always reuses the same agent DID and signing keys.
- `message send` uses application-layer encryption. Only active members addressed in the message body can decrypt the payload.
- `agent feedback add` requires `--contract-id` so portable reputation is grounded in completed or ruled work.
- `serve` does not yet fetch and replay full remote protocol object logs automatically. It currently exposes discoverability through replicated control-feed announcements.

## Notes

- Commands write pretty-printed JSON to stdout so they can be piped into other tooling.
- The signing key is the persisted agent transport key, so the actor DID remains stable across transport and protocol commands.
- The DID document includes both the transport verification key and a `keyAgreement` key for encrypted messaging.
- `serve` runs the current transport runtime. It does not yet synchronize complete remote protocol logs directly; protocol commands mutate the local repository and the transport process handles peer discovery, connectivity, and announcement observation.
