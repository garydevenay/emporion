import type { LightningReference } from "../protocol/index.js";

export const EMPORION_WALLET_KEY_ENV = "EMPORION_WALLET_KEY";

export type WalletBackend = "nwc" | "circle";
export type WalletNetwork = "bitcoin" | "offchain";

export interface WalletConnectionConfig {
  backend: WalletBackend;
  network: WalletNetwork;
  connectionUri: string;
  connectedAt: string;
  endpoint: string;
}

export interface WalletConnectionMetadata {
  backend: WalletBackend;
  network: WalletNetwork;
  connectedAt: string;
  endpoint: string;
}

export type InvoiceStatus = "created" | "paid" | "expired" | "canceled";

export interface InvoiceRecord {
  id: string;
  amount: number;
  memo?: string;
  network: WalletNetwork;
  externalRef: string;
  bolt11: string;
  status: InvoiceStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export type PaymentStatus = "pending" | "succeeded" | "failed";

export interface PaymentRecord {
  id: string;
  sourceRef: string;
  amount: number;
  fee: number;
  externalRef: string;
  status: PaymentStatus;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export type AutoSettleAction = "pay-bolt11";
export type AutoSettleResultState = "succeeded" | "failed" | "skipped";

export interface AutoSettleRecord {
  id: string;
  triggerObjectKind: "offer" | "bid" | "agreement";
  triggerObjectId: string;
  eventId: string;
  lightningReference: string;
  action: AutoSettleAction;
  result: AutoSettleResultState;
  detail?: string;
  paymentId?: string;
  createdAt: string;
}

export interface WalletStatus {
  connected: boolean;
  backend: WalletBackend;
  network: WalletNetwork;
  autoSettleEnabled: boolean;
  pendingPayments: number;
  pendingInvoices: number;
  locked: boolean;
}

export interface WalletLedgerSnapshot {
  invoices: InvoiceRecord[];
  payments: PaymentRecord[];
  autoSettles: AutoSettleRecord[];
}

export interface WalletLedgerListFilters {
  kind?: "invoice" | "payment" | "auto-settle";
  status?: string;
}

export interface CreateInvoiceInput {
  amountSats: number;
  memo?: string;
  expiresAt?: string;
}

export interface CreateInvoiceResult {
  invoice: InvoiceRecord;
  bolt11: string;
}

export interface PayInvoiceInput {
  invoice: string;
  sourceRef?: string;
}

export interface PayInvoiceResult {
  payment: PaymentRecord;
}

export interface PollUpdatesResult {
  updatedInvoices: number;
  updatedPayments: number;
}

export interface AutoSettleCandidate {
  triggerObjectKind: "offer" | "bid" | "agreement";
  triggerObjectId: string;
  eventId: string;
  lightningRef: LightningReference;
  amountSats: number;
}

export interface AutoSettleResult {
  executed: boolean;
  deduped: boolean;
  state?: AutoSettleResultState;
  reason?: string;
  paymentId?: string;
}

export interface DaemonWalletStatus {
  connected: boolean;
  backend: WalletBackend;
  network: WalletNetwork;
  autoSettleEnabled: boolean;
  pendingPayments: number;
  pendingInvoices: number;
}

export interface WalletAdapterCreateInvoiceResult {
  bolt11: string;
  externalRef: string;
  status: InvoiceStatus;
  expiresAt?: string;
}

export interface WalletAdapterPayInvoiceResult {
  externalRef: string;
  amountSats: number;
  feeSats: number;
  status: PaymentStatus;
  failureReason?: string;
}

export interface WalletAdapter {
  createInvoice(input: CreateInvoiceInput): Promise<WalletAdapterCreateInvoiceResult>;
  payInvoice(input: PayInvoiceInput): Promise<WalletAdapterPayInvoiceResult>;
  getInvoiceStatus(externalRef: string): Promise<InvoiceStatus>;
  getPaymentStatus(externalRef: string): Promise<{ status: PaymentStatus; feeSats?: number; failureReason?: string }>;
  disconnect(): Promise<void>;
}
