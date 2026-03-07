import {
  SimplePool,
  finalizeEvent,
  getPublicKey,
  kinds,
  nip04,
  type Event,
  type VerifiedEvent
} from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";

import {
  InvoiceCreationError,
  PaymentFailedError,
  WalletAuthError,
  WalletUnavailableError
} from "../errors.js";
import type {
  CreateInvoiceInput,
  PayInvoiceInput,
  WalletAdapter,
  WalletAdapterCreateInvoiceResult,
  WalletAdapterPayInvoiceResult
} from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

interface ParsedNostrWalletConnect {
  walletPubkey: string;
  relays: string[];
  secret: string;
}

interface NostrNwcResponse {
  result_type?: unknown;
  result?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

export interface NostrNwcClient {
  request(method: string, params: Record<string, unknown>): Promise<NostrNwcResponse>;
  close(): void;
}

function isHex64(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function parseInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toRecordFromJsonString(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    return {};
  }
  const trimmed = value.trim();
  if (trimmed.length < 2 || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return toRecord(parsed);
  } catch {
    return {};
  }
}

function pickString(record: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function candidateRecords(record: Record<string, unknown>): Record<string, unknown>[] {
  return [
    record,
    toRecord(record.invoice),
    toRecord(record.payment),
    toRecord(record.data),
    toRecord(record.details),
    toRecord(record.response)
  ];
}

function pickStringFromCandidates(records: Record<string, unknown>[], fields: string[]): string | undefined {
  for (const record of records) {
    const value = pickString(record, fields);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function pickValueFromCandidates(records: Record<string, unknown>[], fields: string[]): unknown {
  for (const record of records) {
    for (const field of fields) {
      if (Object.hasOwn(record, field)) {
        return record[field];
      }
    }
  }
  return undefined;
}

function summarizeResultShape(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (looksLikeBolt11(trimmed)) {
      return "string:bolt11";
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return "string:json";
    }
    return "string";
  }
  if (typeof value !== "object") {
    return typeof value;
  }
  if (Array.isArray(value)) {
    return `array(len=${value.length})`;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  return `object(keys=${keys.slice(0, 12).join(",") || "<none>"})`;
}

function normalizeHashReference(value: string): string {
  const trimmed = value.trim();
  if (isHex64(trimmed)) {
    return trimmed.toLowerCase();
  }

  // Some providers return payment hashes as base64/base64url (e.g. `r_hash`).
  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  if (!/^[A-Za-z0-9+/=]+$/.test(padded)) {
    return trimmed;
  }

  try {
    const decoded = Buffer.from(padded, "base64");
    if (decoded.length === 32) {
      return decoded.toString("hex");
    }
  } catch {
    // Use the original string when decoding fails.
  }
  return trimmed;
}

function looksLikeBolt11(value: string): boolean {
  return value.trim().toLowerCase().startsWith("ln");
}

function satsToMsats(sats: number): number {
  if (!Number.isFinite(sats) || sats < 0) {
    return 0;
  }
  const safeSats = Math.min(Math.trunc(sats), Math.floor(Number.MAX_SAFE_INTEGER / 1_000));
  return safeSats * 1_000;
}

function msatsToSats(msats: number): number {
  if (!Number.isFinite(msats) || msats < 0) {
    return 0;
  }
  // Round up so local ledger accounting does not understate spent/received sats.
  return Math.ceil(msats / 1_000);
}

function parseAmountSats(records: Record<string, unknown>[]): number {
  const satValue = pickValueFromCandidates(records, ["amount_sats", "amountSat", "amount_sat"]);
  const satParsed = parseInteger(satValue);
  if (satParsed !== undefined && satParsed >= 0) {
    return satParsed;
  }

  const msatValue = pickValueFromCandidates(records, ["amount_msats", "amount_msat"]);
  const msatParsed = parseInteger(msatValue);
  if (msatParsed !== undefined && msatParsed >= 0) {
    return msatsToSats(msatParsed);
  }

  // NIP-47 `amount` is millisatoshis.
  const ambiguousAmount = parseInteger(pickValueFromCandidates(records, ["amount"]));
  if (ambiguousAmount !== undefined && ambiguousAmount >= 0) {
    return msatsToSats(ambiguousAmount);
  }

  return 0;
}

function parseFeeSats(records: Record<string, unknown>[]): number {
  const satValue = pickValueFromCandidates(records, ["fee_sats", "feeSat", "fee_sat"]);
  const satParsed = parseInteger(satValue);
  if (satParsed !== undefined && satParsed >= 0) {
    return satParsed;
  }

  const msatValue = pickValueFromCandidates(records, ["fees_paid_msats", "fees_paid_msat", "fee_msats", "fee_msat"]);
  const msatParsed = parseInteger(msatValue);
  if (msatParsed !== undefined && msatParsed >= 0) {
    return msatsToSats(msatParsed);
  }

  // NIP-47 `fees_paid`/`fee` are commonly millisatoshis.
  const ambiguousFee = parseInteger(pickValueFromCandidates(records, ["fees_paid", "fee"]));
  if (ambiguousFee !== undefined && ambiguousFee >= 0) {
    return msatsToSats(ambiguousFee);
  }

  return 0;
}

function getLookupInvoiceParams(reference: string): Record<string, string> {
  const trimmed = reference.trim();
  if (looksLikeBolt11(trimmed)) {
    return { invoice: trimmed };
  }
  return { payment_hash: trimmed };
}

function normalizeToIsoFromUnix(value: unknown): string | undefined {
  const seconds = parseInteger(value);
  if (seconds === undefined || seconds <= 0) {
    return undefined;
  }
  return new Date(seconds * 1_000).toISOString();
}

function normalizeInvoiceStatus(record: Record<string, unknown>): "created" | "paid" | "expired" | "canceled" {
  if (record.settled_at !== undefined || record.preimage !== undefined || record.paid === true || record.is_paid === true) {
    return "paid";
  }

  const state = String(record.state ?? record.status ?? "").toLowerCase();
  if (state.includes("cancel")) {
    return "canceled";
  }
  if (state.includes("expire") || state.includes("expired")) {
    return "expired";
  }
  if (state.includes("paid") || state.includes("settled") || state.includes("complete")) {
    return "paid";
  }

  const expiresAtSeconds = parseInteger(record.expires_at);
  if (expiresAtSeconds !== undefined && expiresAtSeconds > 0 && expiresAtSeconds <= Math.floor(Date.now() / 1_000)) {
    return "expired";
  }

  return "created";
}

function normalizePaymentStatus(record: Record<string, unknown>): "pending" | "succeeded" | "failed" {
  if (record.preimage !== undefined || record.settled_at !== undefined) {
    return "succeeded";
  }

  const state = String(record.state ?? record.status ?? "").toLowerCase();
  if (state.includes("fail") || state.includes("error")) {
    return "failed";
  }
  if (state.includes("paid") || state.includes("settled") || state.includes("complete")) {
    return "succeeded";
  }
  return "pending";
}

function normalizeRelays(url: URL): string[] {
  const relays = url.searchParams.getAll("relay").map((value) => value.trim()).filter((value) => value.length > 0);
  return [...new Set(relays)];
}

export function isNostrWalletConnectUri(connectionUri: string): boolean {
  return connectionUri.startsWith("nostr+walletconnect://");
}

export function parseNostrWalletConnectConnectionUri(connectionUri: string): ParsedNostrWalletConnect {
  if (!isNostrWalletConnectUri(connectionUri)) {
    throw new WalletUnavailableError("NWC connection URI must start with nostr+walletconnect:// for relay mode");
  }

  let url: URL;
  try {
    url = new URL(connectionUri);
  } catch (error) {
    throw new WalletUnavailableError(`Invalid nostr+walletconnect URI: ${error instanceof Error ? error.message : String(error)}`);
  }

  const walletPubkey = (url.hostname || url.pathname.replace(/^\//, "")).trim();
  const secret = (url.searchParams.get("secret") ?? "").trim();
  const relays = normalizeRelays(url);

  if (!isHex64(walletPubkey)) {
    throw new WalletUnavailableError("nostr+walletconnect URI wallet pubkey must be 32-byte hex");
  }
  if (!isHex64(secret)) {
    throw new WalletUnavailableError("nostr+walletconnect URI secret must be 32-byte hex");
  }
  if (relays.length === 0) {
    throw new WalletUnavailableError("nostr+walletconnect URI must include at least one relay query parameter");
  }

  return {
    walletPubkey,
    relays,
    secret
  };
}

export function parseNostrWalletConnectMetadata(connectionUri: string): { endpoint: string } {
  const parsed = parseNostrWalletConnectConnectionUri(connectionUri);
  return {
    endpoint: `nostr+walletconnect://${parsed.walletPubkey}?relay=${encodeURIComponent(parsed.relays[0] as string)}`
  };
}

class RelayNostrNwcClient implements NostrNwcClient {
  private readonly connection: ParsedNostrWalletConnect;
  private readonly pool = new SimplePool();
  private readonly secretKeyBytes: Uint8Array;
  private readonly clientPubkey: string;

  public constructor(connectionUri: string, private readonly timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.connection = parseNostrWalletConnectConnectionUri(connectionUri);
    this.secretKeyBytes = hexToBytes(this.connection.secret);
    this.clientPubkey = getPublicKey(this.secretKeyBytes);
  }

  public async request(method: string, params: Record<string, unknown>): Promise<NostrNwcResponse> {
    const requestPayload = JSON.stringify({ method, params });
    const encryptedContent = nip04.encrypt(this.connection.secret, this.connection.walletPubkey, requestPayload);
    const requestEvent = finalizeEvent(
      {
        kind: kinds.NWCWalletRequest,
        created_at: Math.floor(Date.now() / 1_000),
        tags: [["p", this.connection.walletPubkey]],
        content: encryptedContent
      },
      this.secretKeyBytes
    );

    const responsePromise = this.waitForResponse(requestEvent);
    await this.publishRequest(requestEvent);
    return responsePromise;
  }

  public close(): void {
    this.pool.destroy();
  }

  private async publishRequest(event: VerifiedEvent): Promise<void> {
    const outcomes = await Promise.allSettled(this.pool.publish(this.connection.relays, event));
    if (outcomes.some((outcome) => outcome.status === "fulfilled")) {
      return;
    }

    const reasons = outcomes
      .map((outcome) => outcome.status === "rejected" ? String(outcome.reason) : "")
      .filter((value) => value.length > 0)
      .join("; ");
    throw new WalletUnavailableError(
      `Failed to publish nostr+walletconnect request to configured relays${reasons ? `: ${reasons}` : ""}`
    );
  }

  private async waitForResponse(requestEvent: Event): Promise<NostrNwcResponse> {
    return await new Promise<NostrNwcResponse>((resolve, reject) => {
      const since = Math.max(0, requestEvent.created_at - 1);
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const closeAndReject = (error: WalletUnavailableError): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        try {
          subscription.close("response-error");
        } catch {
          // Ignore close errors while rejecting.
        }
        reject(error);
      };

      const finish = (response: NostrNwcResponse): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        try {
          subscription.close("response-received");
        } catch {
          // Ignore close errors on successful completion.
        }
        resolve(response);
      };

      const subscription = this.pool.subscribeMany(
        this.connection.relays,
        {
          kinds: [kinds.NWCWalletResponse],
          authors: [this.connection.walletPubkey],
          "#e": [requestEvent.id],
          since
        },
        {
          maxWait: this.timeoutMs,
          onevent: (event) => {
            try {
              const decrypted = nip04.decrypt(this.connection.secret, this.connection.walletPubkey, event.content);
              const payload = JSON.parse(decrypted) as NostrNwcResponse;
              finish(payload);
            } catch (error) {
              closeAndReject(new WalletUnavailableError(
                `Failed to decode nostr+walletconnect response: ${error instanceof Error ? error.message : String(error)}`
              ));
            }
          },
          onclose: (reasons) => {
            if (!settled) {
              closeAndReject(new WalletUnavailableError(
                `Timed out waiting for nostr+walletconnect response (${reasons.join(", ") || "no response"})`
              ));
            }
          }
        }
      );

      timer = setTimeout(() => {
        closeAndReject(new WalletUnavailableError("Timed out waiting for nostr+walletconnect response"));
      }, this.timeoutMs + 500);
      timer.unref();
    });
  }

  public get publicKey(): string {
    return this.clientPubkey;
  }
}

function normalizeResponseError(operation: "createInvoice" | "payInvoice" | "getInvoiceStatus" | "getPaymentStatus", response: NostrNwcResponse): void {
  const errorRecord = response.error;
  if (!errorRecord) {
    return;
  }

  const code = String(errorRecord.code ?? "").toUpperCase();
  const message = String(errorRecord.message ?? `NWC request failed during ${operation}`);
  if (code === "UNAUTHORIZED" || code === "RESTRICTED") {
    throw new WalletAuthError(message);
  }
  if (operation === "createInvoice") {
    throw new InvoiceCreationError(message);
  }
  if (operation === "payInvoice") {
    throw new PaymentFailedError(message);
  }
  throw new WalletUnavailableError(message);
}

function parseLookupResult(response: NostrNwcResponse, operation: "getInvoiceStatus" | "getPaymentStatus"): Record<string, unknown> {
  normalizeResponseError(operation, response);
  return toRecord(response.result);
}

export class NostrWalletConnectAdapter implements WalletAdapter {
  private readonly client: NostrNwcClient;

  public constructor(
    connectionUri: string,
    options?: {
      timeoutMs?: number;
      client?: NostrNwcClient;
    }
  ) {
    this.client = options?.client ?? new RelayNostrNwcClient(connectionUri, options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  }

  public async createInvoice(input: CreateInvoiceInput): Promise<WalletAdapterCreateInvoiceResult> {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const expiry = input.expiresAt ? Math.max(1, Math.floor(Date.parse(input.expiresAt) / 1_000) - nowSeconds) : undefined;

    const response = await this.client.request("make_invoice", {
      amount: satsToMsats(input.amountSats),
      ...(input.memo ? { description: input.memo } : {}),
      ...(expiry ? { expiry } : {})
    });
    normalizeResponseError("createInvoice", response);

    const result = toRecord(response.result);
    const responseRecord = toRecord(response as unknown);
    const parsedResult = toRecordFromJsonString(response.result);
    const records = [
      ...candidateRecords(result),
      ...candidateRecords(parsedResult),
      ...candidateRecords(responseRecord)
    ];
    const directResultString = typeof response.result === "string" ? response.result.trim() : undefined;
    const bolt11 = pickStringFromCandidates(records, [
      "invoice",
      "bolt11",
      "payment_request",
      "paymentRequest",
      "pr",
      "request"
    ]) ?? (directResultString && looksLikeBolt11(directResultString) ? directResultString : undefined);
    const externalRefCandidate = pickStringFromCandidates(records, [
      "payment_hash",
      "r_hash",
      "paymentHash",
      "hash",
      "external_ref",
      "externalRef",
      "invoice_id",
      "id"
    ]);
    const externalRef = externalRefCandidate ? normalizeHashReference(externalRefCandidate) : bolt11;

    if (!bolt11 || !externalRef) {
      throw new InvoiceCreationError(
        `nostr+walletconnect make_invoice did not return invoice and payment hash (resultType=${summarizeResultShape(response.result_type)}, result=${summarizeResultShape(response.result)})`
      );
    }

    const expiresAt = normalizeToIsoFromUnix(result.expires_at);
    return {
      bolt11,
      externalRef,
      status: normalizeInvoiceStatus(result),
      ...(expiresAt ? { expiresAt } : {})
    };
  }

  public async payInvoice(input: PayInvoiceInput): Promise<WalletAdapterPayInvoiceResult> {
    const response = await this.client.request("pay_invoice", {
      invoice: input.invoice
    });
    normalizeResponseError("payInvoice", response);

    const result = toRecord(response.result);
    const responseRecord = toRecord(response as unknown);
    const parsedResult = toRecordFromJsonString(response.result);
    const records = [
      ...candidateRecords(result),
      ...candidateRecords(parsedResult),
      ...candidateRecords(responseRecord)
    ];
    const externalRefCandidate = pickStringFromCandidates(records, [
      "payment_hash",
      "r_hash",
      "paymentHash",
      "hash",
      "external_ref",
      "externalRef",
      "id"
    ]);
    const externalRef = externalRefCandidate ? normalizeHashReference(externalRefCandidate) : input.invoice;
    if (!externalRef) {
      throw new PaymentFailedError("nostr+walletconnect pay_invoice did not return payment hash");
    }

    const status = normalizePaymentStatus(result);
    const amountSats = parseAmountSats(records);
    const feeSats = parseFeeSats(records);

    return {
      externalRef,
      amountSats,
      feeSats,
      status
    };
  }

  public async getInvoiceStatus(externalRef: string): Promise<"created" | "paid" | "expired" | "canceled"> {
    const response = await this.client.request("lookup_invoice", getLookupInvoiceParams(externalRef));
    const result = parseLookupResult(response, "getInvoiceStatus");
    return normalizeInvoiceStatus(result);
  }

  public async getPaymentStatus(externalRef: string): Promise<{
    status: "pending" | "succeeded" | "failed";
    feeSats?: number;
    failureReason?: string;
  }> {
    const response = await this.client.request("lookup_invoice", getLookupInvoiceParams(externalRef));
    const result = parseLookupResult(response, "getPaymentStatus");
    const records = candidateRecords(result);
    const feeSats = parseFeeSats(records);

    return {
      status: normalizePaymentStatus(result),
      ...(feeSats > 0 ? { feeSats } : {})
    };
  }

  public async disconnect(): Promise<void> {
    this.client.close();
  }
}
