import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { WalletUnavailableError } from "../errors.js";
import {
  type AutoSettleRecord,
  type InvoiceRecord,
  type InvoiceStatus,
  type PaymentRecord,
  type PaymentStatus,
  type WalletLedgerListFilters,
  type WalletLedgerSnapshot,
  type WalletNetwork
} from "./types.js";
import { getWalletRuntimeDir } from "./config-store.js";

interface WalletLedgerDocument {
  version: 1;
  invoices: InvoiceRecord[];
  payments: PaymentRecord[];
  autoSettles: AutoSettleRecord[];
}

const LEDGER_FILE = "ledger.v1.json";

function ensureArray<T>(value: unknown, fieldName: string): T[] {
  if (!Array.isArray(value)) {
    throw new WalletUnavailableError(`${fieldName} must be an array`);
  }
  return value as T[];
}

function parseInvoice(value: unknown): InvoiceRecord {
  if (typeof value !== "object" || value === null) {
    throw new WalletUnavailableError("Invalid invoice record in wallet ledger");
  }
  const entry = value as Record<string, unknown>;
  const status = entry.status;
  if (status !== "created" && status !== "paid" && status !== "expired" && status !== "canceled") {
    throw new WalletUnavailableError("Invalid invoice status in wallet ledger");
  }
  if (typeof entry.id !== "string" || typeof entry.externalRef !== "string" || typeof entry.bolt11 !== "string") {
    throw new WalletUnavailableError("Invalid invoice identity fields in wallet ledger");
  }
  if (!Number.isInteger(entry.amount) || (entry.amount as number) < 0) {
    throw new WalletUnavailableError("Invalid invoice amount in wallet ledger");
  }
  if (entry.network !== "bitcoin") {
    throw new WalletUnavailableError("Invalid invoice network in wallet ledger");
  }
  if (typeof entry.createdAt !== "string" || typeof entry.updatedAt !== "string") {
    throw new WalletUnavailableError("Invalid invoice timestamps in wallet ledger");
  }

  const amount = entry.amount as number;
  const memo = typeof entry.memo === "string" ? entry.memo : undefined;
  const expiresAt = typeof entry.expiresAt === "string" ? entry.expiresAt : undefined;

  return {
    id: entry.id,
    amount,
    network: "bitcoin",
    externalRef: entry.externalRef,
    bolt11: entry.bolt11,
    status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(memo ? { memo } : {}),
    ...(expiresAt ? { expiresAt } : {})
  };
}

function parsePayment(value: unknown): PaymentRecord {
  if (typeof value !== "object" || value === null) {
    throw new WalletUnavailableError("Invalid payment record in wallet ledger");
  }

  const entry = value as Record<string, unknown>;
  const status = entry.status;
  if (status !== "pending" && status !== "succeeded" && status !== "failed") {
    throw new WalletUnavailableError("Invalid payment status in wallet ledger");
  }
  if (
    typeof entry.id !== "string" ||
    typeof entry.sourceRef !== "string" ||
    typeof entry.externalRef !== "string" ||
    typeof entry.createdAt !== "string" ||
    typeof entry.updatedAt !== "string"
  ) {
    throw new WalletUnavailableError("Invalid payment identity fields in wallet ledger");
  }
  if (!Number.isInteger(entry.amount) || !Number.isInteger(entry.fee)) {
    throw new WalletUnavailableError("Invalid payment amount/fee in wallet ledger");
  }

  const amount = entry.amount as number;
  const fee = entry.fee as number;
  const failureReason = typeof entry.failureReason === "string" ? entry.failureReason : undefined;

  return {
    id: entry.id,
    sourceRef: entry.sourceRef,
    amount,
    fee,
    externalRef: entry.externalRef,
    status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(failureReason ? { failureReason } : {})
  };
}

function parseAutoSettle(value: unknown): AutoSettleRecord {
  if (typeof value !== "object" || value === null) {
    throw new WalletUnavailableError("Invalid auto-settle record in wallet ledger");
  }

  const entry = value as Record<string, unknown>;
  if (
    typeof entry.id !== "string" ||
    typeof entry.triggerObjectId !== "string" ||
    typeof entry.eventId !== "string" ||
    typeof entry.lightningReference !== "string" ||
    typeof entry.createdAt !== "string"
  ) {
    throw new WalletUnavailableError("Invalid auto-settle identity fields in wallet ledger");
  }
  if (entry.triggerObjectKind !== "offer" && entry.triggerObjectKind !== "bid" && entry.triggerObjectKind !== "agreement") {
    throw new WalletUnavailableError("Invalid auto-settle trigger kind in wallet ledger");
  }
  if (entry.action !== "pay-bolt11") {
    throw new WalletUnavailableError("Invalid auto-settle action in wallet ledger");
  }
  if (entry.result !== "succeeded" && entry.result !== "failed" && entry.result !== "skipped") {
    throw new WalletUnavailableError("Invalid auto-settle result in wallet ledger");
  }

  const detail = typeof entry.detail === "string" ? entry.detail : undefined;
  const paymentId = typeof entry.paymentId === "string" ? entry.paymentId : undefined;

  return {
    id: entry.id,
    triggerObjectKind: entry.triggerObjectKind,
    triggerObjectId: entry.triggerObjectId,
    eventId: entry.eventId,
    lightningReference: entry.lightningReference,
    action: "pay-bolt11",
    result: entry.result,
    createdAt: entry.createdAt,
    ...(detail ? { detail } : {}),
    ...(paymentId ? { paymentId } : {})
  };
}

function canTransitionInvoice(current: InvoiceStatus, next: InvoiceStatus): boolean {
  if (current === next) {
    return true;
  }
  if (current !== "created") {
    return false;
  }
  return next === "paid" || next === "expired" || next === "canceled";
}

function canTransitionPayment(current: PaymentStatus, next: PaymentStatus): boolean {
  if (current === next) {
    return true;
  }
  return current === "pending" && (next === "succeeded" || next === "failed");
}

function dedupeKey(eventId: string, lightningReference: string): string {
  return `${eventId}:${lightningReference}`;
}

export class WalletLedger {
  private readonly ledgerPath: string;
  private readonly invoices = new Map<string, InvoiceRecord>();
  private readonly payments = new Map<string, PaymentRecord>();
  private readonly autoSettles = new Map<string, AutoSettleRecord>();
  private readonly autoSettleIndex = new Map<string, AutoSettleRecord>();

  private constructor(dataDir: string) {
    this.ledgerPath = path.join(getWalletRuntimeDir(dataDir), LEDGER_FILE);
  }

  public static async create(dataDir: string): Promise<WalletLedger> {
    const ledger = new WalletLedger(dataDir);
    await ledger.load();
    return ledger;
  }

  public snapshot(): WalletLedgerSnapshot {
    return {
      invoices: [...this.invoices.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      payments: [...this.payments.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      autoSettles: [...this.autoSettles.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    };
  }

  public list(filters: WalletLedgerListFilters): unknown[] {
    const snapshot = this.snapshot();
    if (filters.kind === "invoice") {
      return filters.status ? snapshot.invoices.filter((entry) => entry.status === filters.status) : snapshot.invoices;
    }
    if (filters.kind === "payment") {
      return filters.status ? snapshot.payments.filter((entry) => entry.status === filters.status) : snapshot.payments;
    }
    if (filters.kind === "auto-settle") {
      return filters.status ? snapshot.autoSettles.filter((entry) => entry.result === filters.status) : snapshot.autoSettles;
    }

    return [...snapshot.invoices, ...snapshot.payments, ...snapshot.autoSettles];
  }

  public getPendingCounts(): { pendingInvoices: number; pendingPayments: number } {
    let pendingInvoices = 0;
    let pendingPayments = 0;

    for (const invoice of this.invoices.values()) {
      if (invoice.status === "created") {
        pendingInvoices += 1;
      }
    }
    for (const payment of this.payments.values()) {
      if (payment.status === "pending") {
        pendingPayments += 1;
      }
    }

    return { pendingInvoices, pendingPayments };
  }

  public listPendingInvoices(): InvoiceRecord[] {
    return [...this.invoices.values()].filter((entry) => entry.status === "created");
  }

  public listPendingPayments(): PaymentRecord[] {
    return [...this.payments.values()].filter((entry) => entry.status === "pending");
  }

  public getInvoiceByExternalRef(externalRef: string): InvoiceRecord | undefined {
    return [...this.invoices.values()].find((entry) => entry.externalRef === externalRef);
  }

  public getPaymentByExternalRef(externalRef: string): PaymentRecord | undefined {
    return [...this.payments.values()].find((entry) => entry.externalRef === externalRef);
  }

  public async addInvoice(input: {
    amount: number;
    memo?: string;
    network: WalletNetwork;
    externalRef: string;
    bolt11: string;
    status: InvoiceStatus;
    expiresAt?: string;
    now: string;
  }): Promise<InvoiceRecord> {
    const record: InvoiceRecord = {
      id: randomUUID(),
      amount: input.amount,
      network: input.network,
      externalRef: input.externalRef,
      bolt11: input.bolt11,
      status: input.status,
      createdAt: input.now,
      updatedAt: input.now,
      ...(input.memo ? { memo: input.memo } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {})
    };
    this.invoices.set(record.id, record);
    await this.persist();
    return record;
  }

  public async transitionInvoice(invoiceId: string, status: InvoiceStatus, now: string): Promise<InvoiceRecord> {
    const existing = this.invoices.get(invoiceId);
    if (!existing) {
      throw new WalletUnavailableError(`Unknown invoice record: ${invoiceId}`);
    }
    if (!canTransitionInvoice(existing.status, status)) {
      throw new WalletUnavailableError(`Invalid invoice status transition: ${existing.status} -> ${status}`);
    }
    if (existing.status === status) {
      return existing;
    }

    const next: InvoiceRecord = {
      ...existing,
      status,
      updatedAt: now
    };
    this.invoices.set(invoiceId, next);
    await this.persist();
    return next;
  }

  public async addPayment(input: {
    sourceRef: string;
    amount: number;
    fee: number;
    externalRef: string;
    status: PaymentStatus;
    failureReason?: string;
    now: string;
  }): Promise<PaymentRecord> {
    const record: PaymentRecord = {
      id: randomUUID(),
      sourceRef: input.sourceRef,
      amount: input.amount,
      fee: input.fee,
      externalRef: input.externalRef,
      status: input.status,
      createdAt: input.now,
      updatedAt: input.now,
      ...(input.failureReason ? { failureReason: input.failureReason } : {})
    };
    this.payments.set(record.id, record);
    await this.persist();
    return record;
  }

  public async transitionPayment(
    paymentId: string,
    status: PaymentStatus,
    now: string,
    options?: { fee?: number; failureReason?: string }
  ): Promise<PaymentRecord> {
    const existing = this.payments.get(paymentId);
    if (!existing) {
      throw new WalletUnavailableError(`Unknown payment record: ${paymentId}`);
    }
    if (!canTransitionPayment(existing.status, status)) {
      throw new WalletUnavailableError(`Invalid payment status transition: ${existing.status} -> ${status}`);
    }
    if (
      existing.status === status &&
      options?.fee === undefined &&
      options?.failureReason === undefined
    ) {
      return existing;
    }

    const next: PaymentRecord = {
      ...existing,
      status,
      fee: options?.fee ?? existing.fee,
      updatedAt: now,
      ...((options?.failureReason ?? existing.failureReason)
        ? { failureReason: options?.failureReason ?? existing.failureReason }
        : {})
    };
    this.payments.set(paymentId, next);
    await this.persist();
    return next;
  }

  public hasAutoSettle(eventId: string, lightningReference: string): boolean {
    return this.autoSettleIndex.has(dedupeKey(eventId, lightningReference));
  }

  public async addAutoSettle(record: Omit<AutoSettleRecord, "id" | "createdAt"> & { createdAt: string }): Promise<AutoSettleRecord> {
    const key = dedupeKey(record.eventId, record.lightningReference);
    const existing = this.autoSettleIndex.get(key);
    if (existing) {
      return existing;
    }

    const next: AutoSettleRecord = {
      ...record,
      id: randomUUID()
    };
    this.autoSettles.set(next.id, next);
    this.autoSettleIndex.set(key, next);
    await this.persist();
    return next;
  }

  private async load(): Promise<void> {
    await mkdir(path.dirname(this.ledgerPath), { recursive: true });

    try {
      const raw = await readFile(this.ledgerPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<WalletLedgerDocument>;
      if (parsed.version !== 1) {
        throw new WalletUnavailableError("Wallet ledger version is invalid");
      }

      for (const invoice of ensureArray<unknown>(parsed.invoices, "wallet ledger invoices")) {
        const parsedInvoice = parseInvoice(invoice);
        this.invoices.set(parsedInvoice.id, parsedInvoice);
      }
      for (const payment of ensureArray<unknown>(parsed.payments, "wallet ledger payments")) {
        const parsedPayment = parsePayment(payment);
        this.payments.set(parsedPayment.id, parsedPayment);
      }
      for (const autoSettle of ensureArray<unknown>(parsed.autoSettles, "wallet ledger autoSettles")) {
        const parsedAutoSettle = parseAutoSettle(autoSettle);
        this.autoSettles.set(parsedAutoSettle.id, parsedAutoSettle);
        this.autoSettleIndex.set(dedupeKey(parsedAutoSettle.eventId, parsedAutoSettle.lightningReference), parsedAutoSettle);
      }
    } catch (error) {
      if (error instanceof WalletUnavailableError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("ENOENT")) {
        await this.persist();
        return;
      }
      throw new WalletUnavailableError(`Failed to load wallet ledger: ${message}`, { cause: error });
    }
  }

  private async persist(): Promise<void> {
    const document: WalletLedgerDocument = {
      version: 1,
      invoices: [...this.invoices.values()],
      payments: [...this.payments.values()],
      autoSettles: [...this.autoSettles.values()]
    };
    await writeFile(this.ledgerPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }
}
