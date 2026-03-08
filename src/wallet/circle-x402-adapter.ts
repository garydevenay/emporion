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
const DEFAULT_PAYMENTS_PATH = "/v1/nanopayments/payments";

interface ParsedCircleConnection {
  endpoint: URL;
  endpointDisplay: string;
  paymentsPath: string;
  paymentStatusPathTemplate: string;
  apiKey?: string;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function pickString(record: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function normalizePaymentStatus(value: unknown): "pending" | "succeeded" | "failed" {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["succeeded", "success", "paid", "settled", "complete", "completed"].includes(normalized)) {
    return "succeeded";
  }
  if (["failed", "error", "rejected", "canceled", "cancelled"].includes(normalized)) {
    return "failed";
  }
  return "pending";
}

export function isCircleX402ConnectionUri(connectionUri: string): boolean {
  return connectionUri.startsWith("circle+http://") || connectionUri.startsWith("circle+https://");
}

function parseCircleConnectionUri(connectionUri: string): ParsedCircleConnection {
  if (!isCircleX402ConnectionUri(connectionUri)) {
    throw new WalletUnavailableError("Circle connection URI must start with circle+http:// or circle+https://");
  }

  const normalized = connectionUri.replace(/^circle\+/, "");
  let endpoint: URL;
  try {
    endpoint = new URL(normalized);
  } catch (error) {
    throw new WalletUnavailableError(`Invalid Circle connection URI: ${toErrorMessage(error)}`);
  }

  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new WalletUnavailableError("Circle endpoint protocol must be http or https");
  }

  const apiKey = endpoint.searchParams.get("api-key")
    ?? endpoint.searchParams.get("apiKey")
    ?? endpoint.searchParams.get("token")
    ?? undefined;
  const paymentsPath = endpoint.searchParams.get("payments-path") ?? DEFAULT_PAYMENTS_PATH;
  const paymentStatusPathTemplate = endpoint.searchParams.get("payment-status-path") ?? `${paymentsPath}/{paymentId}`;
  const endpointDisplay = `${endpoint.origin}${endpoint.pathname === "/" ? "" : endpoint.pathname}${paymentsPath}`;

  return {
    endpoint,
    endpointDisplay,
    paymentsPath,
    paymentStatusPathTemplate,
    ...(apiKey ? { apiKey } : {})
  };
}

export function parseCircleConnectionMetadata(connectionUri: string): {
  endpoint: string;
} {
  const parsed = parseCircleConnectionUri(connectionUri);
  return {
    endpoint: parsed.endpointDisplay
  };
}

export class CircleX402WalletAdapter implements WalletAdapter {
  private readonly endpoint: URL;
  private readonly paymentsPath: string;
  private readonly paymentStatusPathTemplate: string;
  private readonly apiKey?: string;

  public constructor(connectionUri: string, private readonly timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const parsed = parseCircleConnectionUri(connectionUri);
    this.endpoint = parsed.endpoint;
    this.paymentsPath = parsed.paymentsPath;
    this.paymentStatusPathTemplate = parsed.paymentStatusPathTemplate;
    if (parsed.apiKey) {
      this.apiKey = parsed.apiKey;
    }
  }

  public async createInvoice(_input: CreateInvoiceInput): Promise<WalletAdapterCreateInvoiceResult> {
    throw new InvoiceCreationError("Circle x402 backend does not support invoice creation");
  }

  public async payInvoice(input: PayInvoiceInput): Promise<WalletAdapterPayInvoiceResult> {
    const payload: Record<string, unknown> = {
      idempotencyKey: randomUUID()
    };

    const invoice = input.invoice.trim();
    if (invoice.startsWith("{")) {
      try {
        Object.assign(payload, JSON.parse(invoice) as Record<string, unknown>);
      } catch (error) {
        throw new PaymentFailedError(`--resource JSON must be valid: ${toErrorMessage(error)}`);
      }
    } else {
      payload.resource = invoice;
    }
    if (input.sourceRef) {
      payload.sourceRef = input.sourceRef;
    }

    const response = await this.request("POST", this.paymentsPath, "payInvoice", payload);
    const record = toRecord(response);

    const externalRef = pickString(record, ["paymentId", "payment_id", "id", "externalRef", "external_ref"]);
    if (!externalRef) {
      throw new PaymentFailedError("Circle response did not include payment identifier");
    }

    const status = normalizePaymentStatus(record.status);
    const amountSats = parseInteger(record.amount_minor ?? record.amountMinor ?? record.amount) ?? 0;
    const feeSats = parseInteger(record.fee_minor ?? record.feeMinor ?? record.fee) ?? 0;
    const failureReason = pickString(record, ["failure_reason", "failureReason", "error", "message"]);

    if (status === "failed") {
      throw new PaymentFailedError(failureReason ?? "Circle payment failed");
    }

    return {
      externalRef,
      amountSats,
      feeSats,
      status,
      ...(failureReason ? { failureReason } : {})
    };
  }

  public async getInvoiceStatus(_externalRef: string): Promise<"created" | "paid" | "expired" | "canceled"> {
    throw new WalletUnavailableError("Circle x402 backend does not support invoice status");
  }

  public async getPaymentStatus(externalRef: string): Promise<{
    status: "pending" | "succeeded" | "failed";
    feeSats?: number;
    failureReason?: string;
  }> {
    const encodedRef = encodeURIComponent(externalRef);
    const path = this.paymentStatusPathTemplate.replaceAll("{paymentId}", encodedRef);
    const response = await this.request("GET", path, "getPaymentStatus");
    const record = toRecord(response);
    const status = normalizePaymentStatus(record.status);
    const feeSats = parseInteger(record.fee_minor ?? record.feeMinor ?? record.fee);
    const failureReason = pickString(record, ["failure_reason", "failureReason", "error", "message"]);

    return {
      status,
      ...(feeSats !== undefined ? { feeSats } : {}),
      ...(failureReason ? { failureReason } : {})
    };
  }

  public async disconnect(): Promise<void> {
    // HTTP-based adapter has no persistent session to close.
  }

  private async request(
    method: "GET" | "POST",
    endpointPath: string,
    operation: "payInvoice" | "getPaymentStatus",
    payload?: Record<string, unknown>
  ): Promise<unknown> {
    const url = new URL(endpointPath, this.endpoint);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: controller.signal
      });

      if (response.status === 401 || response.status === 403) {
        throw new WalletAuthError(`Wallet authentication failed during ${operation}`);
      }

      let responseJson: unknown;
      try {
        responseJson = await response.json();
      } catch (error) {
        throw new WalletUnavailableError(`Circle provider returned invalid JSON during ${operation}`, { cause: error });
      }
      const responseRecord = toRecord(responseJson);
      const errorMessage = pickString(responseRecord, ["message", "error", "details"]);

      if (!response.ok) {
        if (operation === "payInvoice") {
          throw new PaymentFailedError(
            errorMessage ?? `Circle provider returned HTTP ${response.status} during ${operation}`
          );
        }
        throw new WalletUnavailableError(
          errorMessage ?? `Circle provider returned HTTP ${response.status} during ${operation}`
        );
      }

      return responseJson;
    } catch (error) {
      if (error instanceof WalletAuthError || error instanceof WalletUnavailableError || error instanceof PaymentFailedError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new WalletUnavailableError(`Circle provider timed out during ${operation}`);
      }
      throw new WalletUnavailableError(`Circle provider request failed during ${operation}: ${toErrorMessage(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
