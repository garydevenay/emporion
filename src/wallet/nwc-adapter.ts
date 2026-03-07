import { randomUUID } from "node:crypto";

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

interface NwcJsonRpcSuccess {
  jsonrpc?: string;
  id?: string;
  result?: unknown;
}

interface NwcJsonRpcError {
  jsonrpc?: string;
  id?: string;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface ParsedNwcConnection {
  endpoint: URL;
  token?: string;
  endpointDisplay: string;
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

function pickString(record: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeInvoiceStatus(value: unknown): "created" | "paid" | "expired" | "canceled" {
  if (value === "paid" || value === "settled" || value === "complete") {
    return "paid";
  }
  if (value === "expired") {
    return "expired";
  }
  if (value === "canceled" || value === "cancelled") {
    return "canceled";
  }
  return "created";
}

function normalizePaymentStatus(value: unknown): "pending" | "succeeded" | "failed" {
  if (value === "succeeded" || value === "paid" || value === "settled" || value === "complete") {
    return "succeeded";
  }
  if (value === "failed" || value === "error") {
    return "failed";
  }
  return "pending";
}

function normalizeExpiresAt(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  const seconds = parseInteger(value);
  if (seconds !== undefined && seconds > 0) {
    return new Date(seconds * 1_000).toISOString();
  }
  return undefined;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseNwcConnectionUri(connectionUri: string): ParsedNwcConnection {
  if (!connectionUri.startsWith("nwc+http://") && !connectionUri.startsWith("nwc+https://")) {
    throw new WalletUnavailableError(
      "NWC connection URI must start with nwc+http:// or nwc+https://"
    );
  }

  const normalized = connectionUri.replace(/^nwc\+/, "");
  let endpoint: URL;
  try {
    endpoint = new URL(normalized);
  } catch (error) {
    throw new WalletUnavailableError(`Invalid NWC connection URI: ${toErrorMessage(error)}`);
  }

  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new WalletUnavailableError("NWC endpoint protocol must be http or https");
  }

  const token = endpoint.searchParams.get("token") ?? undefined;
  const endpointDisplay = `${endpoint.origin}${endpoint.pathname}`;

  return {
    endpoint,
    endpointDisplay,
    ...(token ? { token } : {})
  };
}

export function parseNwcConnectionMetadata(connectionUri: string): {
  endpoint: string;
} {
  const parsed = parseNwcConnectionUri(connectionUri);
  return {
    endpoint: parsed.endpointDisplay
  };
}

export class NwcWalletAdapter implements WalletAdapter {
  private readonly endpoint: URL;
  private readonly token?: string;

  public constructor(connectionUri: string, private readonly timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const parsed = parseNwcConnectionUri(connectionUri);
    this.endpoint = parsed.endpoint;
    if (parsed.token) {
      this.token = parsed.token;
    }
  }

  public async createInvoice(input: CreateInvoiceInput): Promise<WalletAdapterCreateInvoiceResult> {
    const response = await this.callRpc("create_invoice", {
      amount: input.amountSats,
      memo: input.memo,
      expires_at: input.expiresAt
    }, "createInvoice");
    const record = toRecord(response);

    const bolt11 = pickString(record, ["bolt11", "invoice", "payment_request"]);
    const externalRef = pickString(record, ["external_ref", "payment_hash", "id"]);

    if (!bolt11 || !externalRef) {
      throw new InvoiceCreationError("NWC response did not include invoice and external reference");
    }

    const expiresAt = normalizeExpiresAt(record.expires_at ?? record.expiresAt);
    return {
      bolt11,
      externalRef,
      status: normalizeInvoiceStatus(record.status),
      ...(expiresAt ? { expiresAt } : {})
    };
  }

  public async payInvoice(input: PayInvoiceInput): Promise<WalletAdapterPayInvoiceResult> {
    const response = await this.callRpc("pay_invoice", {
      invoice: input.invoice
    }, "payInvoice");
    const record = toRecord(response);

    const externalRef = pickString(record, ["external_ref", "payment_hash", "id"]);
    if (!externalRef) {
      throw new PaymentFailedError("NWC response did not include payment external reference");
    }

    const status = normalizePaymentStatus(record.status ?? (record.preimage ? "succeeded" : "pending"));
    const amountSats = parseInteger(record.amount_sats ?? record.amount) ?? 0;
    const feeSats = parseInteger(record.fee_sats ?? record.fee_paid ?? record.fee) ?? 0;
    const failureReason = pickString(record, ["failure_reason", "error", "message"]);

    if (status === "failed") {
      throw new PaymentFailedError(failureReason ?? "Payment failed via NWC");
    }

    return {
      externalRef,
      amountSats,
      feeSats,
      status,
      ...(failureReason ? { failureReason } : {})
    };
  }

  public async getInvoiceStatus(externalRef: string): Promise<"created" | "paid" | "expired" | "canceled"> {
    const response = await this.callRpc("get_invoice", {
      external_ref: externalRef
    }, "getInvoiceStatus");
    return normalizeInvoiceStatus(toRecord(response).status);
  }

  public async getPaymentStatus(externalRef: string): Promise<{
    status: "pending" | "succeeded" | "failed";
    feeSats?: number;
    failureReason?: string;
  }> {
    const response = await this.callRpc("get_payment", {
      external_ref: externalRef
    }, "getPaymentStatus");
    const record = toRecord(response);
    const status = normalizePaymentStatus(record.status);

    const feeSats = parseInteger(record.fee_sats ?? record.fee_paid ?? record.fee);
    const failureReason = pickString(record, ["failure_reason", "error", "message"]);
    return {
      status,
      ...(feeSats !== undefined ? { feeSats } : {}),
      ...(failureReason ? { failureReason } : {})
    };
  }

  public async disconnect(): Promise<void> {
    // HTTP-based adapter has no persistent session to close.
  }

  private async callRpc(method: string, params: Record<string, unknown>, operation: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: randomUUID(),
          method,
          params
        }),
        signal: controller.signal
      });

      if (response.status === 401 || response.status === 403) {
        throw new WalletAuthError(`Wallet authentication failed during ${operation}`);
      }
      if (!response.ok) {
        throw new WalletUnavailableError(
          `Wallet provider returned HTTP ${response.status} during ${operation}`
        );
      }

      let payload: NwcJsonRpcSuccess | NwcJsonRpcError;
      try {
        payload = (await response.json()) as NwcJsonRpcSuccess | NwcJsonRpcError;
      } catch (error) {
        throw new WalletUnavailableError(`Wallet provider returned invalid JSON during ${operation}`, {
          cause: error
        });
      }

      if (payload && typeof payload === "object" && "error" in payload && payload.error) {
        const code = payload.error.code;
        const message = payload.error.message ?? `Wallet provider error during ${operation}`;
        if (code === 401 || code === 403) {
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

      return (payload as NwcJsonRpcSuccess).result;
    } catch (error) {
      if (error instanceof WalletAuthError || error instanceof WalletUnavailableError || error instanceof InvoiceCreationError || error instanceof PaymentFailedError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new WalletUnavailableError(`Wallet provider timed out during ${operation}`);
      }
      throw new WalletUnavailableError(`Wallet provider request failed during ${operation}: ${toErrorMessage(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
