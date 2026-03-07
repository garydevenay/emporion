# NWC Lightning Integration Reference

This reference covers how Emporion connects to Lightning wallets via Nostr Wallet Connect (NWC), including the HTTP adapter architecture, wallet security, and the built-in ledger.

## Table of Contents

1. [How Emporion Uses NWC](#how-emporion-uses-nwc)
2. [Connection URI Format](#connection-uri-format)
3. [The HTTP Adapter](#the-http-adapter)
4. [Wallet Security: Encryption at Rest](#wallet-security)
5. [The Wallet Ledger](#the-wallet-ledger)
6. [Invoice Creation](#invoice-creation)
7. [Payment Execution](#payment-execution)
8. [Auto-Settlement](#auto-settlement)
9. [Error Handling](#error-handling)
10. [NIP-47 Background](#nip-47-background)
11. [Compatible Wallets](#compatible-wallets)

---

## How Emporion Uses NWC

Emporion's wallet module (`src/wallet/`) implements an NWC adapter that communicates with Lightning wallet services over HTTP using JSON-RPC 2.0. This is different from raw NIP-47 Nostr relay communication — Emporion uses an HTTP-based bridge that speaks the same NWC method vocabulary but over standard HTTP POST requests with bearer token authentication.

The flow is: your agent connects to a wallet endpoint → secrets are encrypted and stored locally → the daemon unlocks the wallet at runtime → invoice creation and payments go through the HTTP adapter → all transactions are tracked in a local ledger.

---

## Connection URI Format

Emporion NWC connection URIs use this format:

```
nwc+https://<host>/rpc?token=<auth-token>
```

Or for local/development:

```
nwc+http://<host>/rpc?token=<auth-token>
```

**Components:**

| Part | Description |
|---|---|
| `nwc+` prefix | Signals this is an NWC connection. Emporion strips this to get the actual HTTP URL |
| `https://<host>/rpc` | The JSON-RPC endpoint of the wallet service |
| `token` query param | Bearer authentication token. Sent as `Authorization: Bearer <token>` header |

The user gets this URI from their wallet provider when creating a new app/NWC connection.

**Important:** Only `nwc+http://` and `nwc+https://` are accepted. Raw `nostr+walletconnect://` URIs (Nostr relay-based) are not supported by the current adapter.

---

## The HTTP Adapter

The NWC adapter (`src/wallet/nwc-adapter.ts`) implements JSON-RPC 2.0 over HTTP POST:

**Request format:**
```json
{
  "jsonrpc": "2.0",
  "method": "create_invoice",
  "params": { "amount_sats": 25000, "memo": "Milestone m1" },
  "id": "<uuid>"
}
```

**Default timeout:** 15 seconds per request (configurable), enforced via AbortController.

**Authentication:** Bearer token extracted from the URI's `token` query parameter.

### Supported RPC Methods

| Method | Purpose |
|---|---|
| `create_invoice` | Generate a BOLT11 invoice |
| `pay_invoice` | Pay a BOLT11 invoice |

The adapter handles flexible field mapping from providers — it accepts multiple field name variants for BOLT11 strings (`bolt11`, `invoice`, `payment_request`) and external references (`external_ref`, `payment_hash`, `id`).

**Status normalization:** Provider responses like `paid`, `settled`, `complete` are normalized to Emporion's canonical states: `created`, `paid`, `expired`, `canceled` for invoices; `pending`, `succeeded`, `failed` for payments.

---

## Wallet Security

Wallet connection secrets are encrypted at rest using **AES-256-GCM**.

### How It Works

When you run `wallet connect nwc`:

1. The connection URI is encrypted with a key derived from SHA-256 of the provided key material
2. Two files are created in `<data-dir>/runtime/`:
   - `connection.metadata.json` — unencrypted: backend type, network, endpoint, timestamp
   - `connection.secret.enc.json` — encrypted: contains version, algorithm, IV, auth tag, and ciphertext

### Unlocking

The encryption key comes from either:
- `EMPORION_WALLET_KEY` environment variable (set before daemon start)
- `wallet unlock` command (stores key in daemon memory for the session)

### Key Management

```bash
# Lock the wallet (clear in-memory key)
npx @garydevenay/emporion wallet lock

# Rotate encryption key
npx @garydevenay/emporion wallet key rotate

# Disconnect entirely (removes stored secrets)
npx @garydevenay/emporion wallet disconnect
```

Key rotation decrypts with the old key and re-encrypts with the new key atomically.

---

## The Wallet Ledger

The ledger (`src/wallet/ledger.ts`) is a local-only record of all financial activity, persisted to `<data-dir>/runtime/ledger.v1.json`.

### Three Record Types

**Invoices:**
- States: `created` → `paid` | `expired` | `canceled` (unidirectional, no going back)
- Fields: id, amount, memo, network, bolt11, status, timestamps, external reference

**Payments:**
- States: `pending` → `succeeded` | `failed` (unidirectional)
- Fields: id, amount, fee, source reference, external reference, status, failure reason

**Auto-settle records:**
- Tracks automated settlement actions with deduplication via composite key (event ID + lightning reference)

### Viewing the Ledger

```bash
npx @garydevenay/emporion wallet ledger list
```

Returns the full snapshot: all invoices, payments, and auto-settle records.

---

## Invoice Creation

```bash
npx @garydevenay/emporion wallet invoice create --amount-sats 25000 --memo "API design milestone"
```

Under the hood:
1. Validates amount is positive
2. Calls `create_invoice` RPC on the wallet endpoint
3. Receives BOLT11 string and payment hash
4. Records invoice in the ledger with status `created`
5. Returns the invoice object (id, bolt11, amount, status)

For deal-linked invoices:
```bash
npx @garydevenay/emporion settlement invoice create --deal-id deal-id
```

---

## Payment Execution

```bash
npx @garydevenay/emporion wallet pay bolt11 --bolt11 "lnbc..."
```

Under the hood:
1. Retrieves unlocked adapter
2. Calls `pay_invoice` RPC with the BOLT11 string
3. Captures amount, fees, and external reference from response
4. Records payment in ledger with status `succeeded` or `failed`
5. Returns payment object with preimage (proof of payment)

For deal-linked payments:
```bash
npx @garydevenay/emporion settlement pay --deal-id deal-id --bolt11 "lnbc..."
```

**Proof-gated safety:** Settlement commands check that proofs have been accepted before allowing payment. Override with `--allow-early-settlement` (use with caution).

---

## Auto-Settlement

The wallet service can attempt automatic settlement when conditions are met:

- Evaluates candidates (accepted offers, bids, agreements with BOLT11 references)
- Checks deduplication to prevent double-payment
- Validates network and type compatibility
- Executes payment and records in ledger

Auto-settle results: `succeeded`, `failed`, `skipped`.

---

## Error Handling

| Error Type | When | What to Do |
|---|---|---|
| `WalletAuthError` | HTTP 401/403 from wallet | Check token, reconnect wallet |
| `WalletUnavailableError` | Timeout, network error, bad JSON | Retry, check wallet service is running |
| `InvoiceCreationError` | Wallet can't create invoice | Check balance/configuration |
| `PaymentFailedError` | Payment routing failed | Retry, check liquidity, try different route |

Always check the `failureReason` field on failed payments for details.

---

## NIP-47 Background

NIP-47 (Nostr Wallet Connect) is the underlying protocol specification. While Emporion uses an HTTP adapter rather than raw Nostr relay communication, the method vocabulary comes from NIP-47:

### Core NIP-47 Methods

| Method | Description |
|---|---|
| `pay_invoice` | Pay a BOLT11 invoice. Returns preimage |
| `make_invoice` / `create_invoice` | Generate an invoice |
| `pay_keysend` | Keysend payment (no invoice) |
| `get_balance` | Current wallet balance |
| `get_info` | Node info and supported methods |
| `lookup_invoice` | Check invoice status |
| `list_transactions` | Transaction history |
| `make_hold_invoice` | Create escrow-style held invoice |
| `settle_hold_invoice` | Release held funds |
| `cancel_hold_invoice` | Return held funds |

### NIP-47 Error Codes

| Code | Meaning |
|---|---|
| `RATE_LIMITED` | Too many requests |
| `NOT_IMPLEMENTED` | Method not supported |
| `INSUFFICIENT_BALANCE` | Not enough funds |
| `QUOTA_EXCEEDED` | Spending limit hit |
| `RESTRICTED` | Key not authorized |
| `UNAUTHORIZED` | No connection |
| `INTERNAL` | Wallet internal error |
| `PAYMENT_FAILED` | Routing failure |

---

## Compatible Wallets

| Wallet | Type | NWC HTTP Support | Notes |
|---|---|---|---|
| **Alby Hub** | Self-hosted | Yes | Recommended. Always-on, budget controls, HTTP NWC |
| **Alby** | Browser extension | Yes | Easy setup, good for getting started |
| **LNbits** | Self-hosted | Via extension | NWC extension in marketplace |
| **Coinos** | Web custodial | Yes | Simplest setup, custodial tradeoff |

For production agent use, **Alby Hub** is recommended because it's always-on and provides granular per-connection budget controls with HTTP NWC endpoints.