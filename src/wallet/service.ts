import { createLogger, type Logger } from "../logger.js";
import {
  InvoiceCreationError,
  PaymentFailedError,
  WalletAuthError,
  WalletUnavailableError
} from "../errors.js";
import { type LightningReference } from "../protocol/index.js";
import {
  WalletConfigStore,
  getWalletKeyFromEnv
} from "./config-store.js";
import { WalletLedger } from "./ledger.js";
import {
  NwcWalletAdapter,
  parseNwcConnectionMetadata
} from "./nwc-adapter.js";
import {
  NostrWalletConnectAdapter,
  isNostrWalletConnectUri,
  parseNostrWalletConnectMetadata
} from "./nostr-nwc-adapter.js";
import type {
  AutoSettleCandidate,
  AutoSettleResult,
  CreateInvoiceInput,
  CreateInvoiceResult,
  DaemonWalletStatus,
  PayInvoiceInput,
  PayInvoiceResult,
  PollUpdatesResult,
  WalletAdapter,
  WalletLedgerListFilters,
  WalletStatus
} from "./types.js";

interface WalletServiceOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  requireUnlockOnStart?: boolean;
  now?: () => string;
  adapterFactory?: (connectionUri: string) => WalletAdapter;
}

function normalizeUnknownError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}

function lightningReferenceDedupeKey(ref: LightningReference): string {
  return `${ref.type}:${ref.network}:${ref.reference}`;
}

function parseWalletConnectionMetadata(connectionUri: string): { endpoint: string } {
  if (isNostrWalletConnectUri(connectionUri)) {
    return parseNostrWalletConnectMetadata(connectionUri);
  }
  return parseNwcConnectionMetadata(connectionUri);
}

function createWalletAdapterForConnection(connectionUri: string): WalletAdapter {
  if (isNostrWalletConnectUri(connectionUri)) {
    return new NostrWalletConnectAdapter(connectionUri);
  }
  return new NwcWalletAdapter(connectionUri);
}

export class WalletService {
  private readonly configStore: WalletConfigStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: Logger;
  private readonly adapterFactory: (connectionUri: string) => WalletAdapter;
  private readonly now: () => string;
  private runtimeWalletKey: string | null = null;

  private readonly ledger: WalletLedger;
  private adapterCache: {
    connectionUri: string;
    adapter: WalletAdapter;
  } | null = null;

  private constructor(options: WalletServiceOptions, ledger: WalletLedger) {
    this.configStore = new WalletConfigStore(options.dataDir);
    this.ledger = ledger;
    this.env = options.env ?? process.env;
    this.logger = options.logger ?? createLogger("error");
    this.adapterFactory = options.adapterFactory ?? createWalletAdapterForConnection;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public static async create(options: WalletServiceOptions): Promise<WalletService> {
    const ledger = await WalletLedger.create(options.dataDir);
    const service = new WalletService(options, ledger);
    if (options.requireUnlockOnStart) {
      await service.assertUnlockIfConfigured();
    }
    return service;
  }

  public async close(): Promise<void> {
    if (this.adapterCache) {
      await this.adapterCache.adapter.disconnect();
      this.adapterCache = null;
    }
  }

  public async connect(connectionUri: string): Promise<{ status: WalletStatus; endpoint: string }> {
    const keyMaterial = this.getWalletKey();
    const metadata = parseWalletConnectionMetadata(connectionUri);
    await this.configStore.writeConnection(
      {
        backend: "nwc",
        network: "bitcoin",
        connectionUri,
        endpoint: metadata.endpoint,
        connectedAt: this.now()
      },
      keyMaterial
    );

    if (this.adapterCache) {
      await this.adapterCache.adapter.disconnect();
      this.adapterCache = null;
    }

    return {
      status: await this.status(),
      endpoint: metadata.endpoint
    };
  }

  public async disconnect(): Promise<WalletStatus> {
    if (this.adapterCache) {
      await this.adapterCache.adapter.disconnect();
      this.adapterCache = null;
    }
    await this.configStore.clearConnection();
    return this.status();
  }

  public async rotateKey(newKeyMaterial: string): Promise<void> {
    const currentKey = this.getWalletKey();
    if (newKeyMaterial.trim().length === 0) {
      throw new WalletAuthError("New wallet key must not be blank");
    }
    await this.configStore.rotateKey(currentKey, newKeyMaterial);
  }

  public async status(): Promise<WalletStatus> {
    const metadata = await this.configStore.readMetadata();
    const { pendingInvoices, pendingPayments } = this.ledger.getPendingCounts();

    if (!metadata) {
      return {
        connected: false,
        backend: "nwc",
        network: "bitcoin",
        autoSettleEnabled: false,
        pendingInvoices,
        pendingPayments,
        locked: false
      };
    }

    const locked = !(await this.canUnlockConfig());

    return {
      connected: true,
      backend: "nwc",
      network: "bitcoin",
      autoSettleEnabled: !locked,
      pendingInvoices,
      pendingPayments,
      locked
    };
  }

  public async daemonStatus(): Promise<DaemonWalletStatus> {
    const status = await this.status();
    return {
      connected: status.connected,
      backend: status.backend,
      network: status.network,
      autoSettleEnabled: status.autoSettleEnabled,
      pendingInvoices: status.pendingInvoices,
      pendingPayments: status.pendingPayments
    };
  }

  public async createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult> {
    assertPositiveInteger(input.amountSats, "--amount-sats");
    const adapter = await this.getUnlockedAdapter();

    let adapterResult;
    try {
      adapterResult = await adapter.createInvoice(input);
    } catch (error) {
      if (error instanceof InvoiceCreationError || error instanceof WalletAuthError || error instanceof WalletUnavailableError) {
        throw error;
      }
      throw new InvoiceCreationError(normalizeUnknownError(error).message, { cause: error });
    }

    const invoice = await this.ledger.addInvoice({
      amount: input.amountSats,
      network: "bitcoin",
      externalRef: adapterResult.externalRef,
      bolt11: adapterResult.bolt11,
      status: adapterResult.status,
      now: this.now(),
      ...(input.memo ? { memo: input.memo } : {}),
      ...(adapterResult.expiresAt ? { expiresAt: adapterResult.expiresAt } : {})
    });

    return {
      invoice,
      bolt11: adapterResult.bolt11
    };
  }

  public async payInvoice(input: PayInvoiceInput): Promise<PayInvoiceResult> {
    const adapter = await this.getUnlockedAdapter();

    let adapterResult;
    try {
      adapterResult = await adapter.payInvoice(input);
    } catch (error) {
      if (error instanceof PaymentFailedError || error instanceof WalletAuthError || error instanceof WalletUnavailableError) {
        throw error;
      }
      throw new PaymentFailedError(normalizeUnknownError(error).message, { cause: error });
    }

    const now = this.now();
    const payment = await this.ledger.addPayment({
      sourceRef: input.sourceRef ?? input.invoice,
      amount: adapterResult.amountSats,
      fee: adapterResult.feeSats,
      externalRef: adapterResult.externalRef,
      status: adapterResult.status,
      now,
      ...(adapterResult.failureReason ? { failureReason: adapterResult.failureReason } : {})
    });

    return {
      payment
    };
  }

  public async listLedger(filters: WalletLedgerListFilters): Promise<unknown[]> {
    return this.ledger.list(filters);
  }

  public async pollUpdates(): Promise<PollUpdatesResult> {
    const currentStatus = await this.status();
    if (!currentStatus.connected || currentStatus.locked) {
      return { updatedInvoices: 0, updatedPayments: 0 };
    }

    const adapter = await this.getUnlockedAdapter();
    let updatedInvoices = 0;
    let updatedPayments = 0;

    for (const invoice of this.ledger.listPendingInvoices()) {
      try {
        const nextStatus = await adapter.getInvoiceStatus(invoice.externalRef);
        if (nextStatus !== invoice.status) {
          await this.ledger.transitionInvoice(invoice.id, nextStatus, this.now());
          updatedInvoices += 1;
        }
      } catch (error) {
        this.logger.warn("Wallet poll invoice update failed", {
          invoiceId: invoice.id,
          error: normalizeUnknownError(error).message
        });
      }
    }

    for (const payment of this.ledger.listPendingPayments()) {
      try {
        const next = await adapter.getPaymentStatus(payment.externalRef);
        if (next.status !== payment.status || next.feeSats !== undefined || next.failureReason !== undefined) {
          const transitionOptions = {
            ...(next.feeSats !== undefined ? { fee: next.feeSats } : {}),
            ...(next.failureReason ? { failureReason: next.failureReason } : {})
          };
          await this.ledger.transitionPayment(payment.id, next.status, this.now(), {
            ...transitionOptions
          });
          updatedPayments += 1;
        }
      } catch (error) {
        this.logger.warn("Wallet poll payment update failed", {
          paymentId: payment.id,
          error: normalizeUnknownError(error).message
        });
      }
    }

    return {
      updatedInvoices,
      updatedPayments
    };
  }

  public async attemptAutoSettle(candidate: AutoSettleCandidate): Promise<AutoSettleResult> {
    const status = await this.status();
    if (!status.connected || status.locked) {
      return {
        executed: false,
        deduped: false,
        reason: "wallet-unavailable"
      };
    }

    const lightningReference = lightningReferenceDedupeKey(candidate.lightningRef);
    if (this.ledger.hasAutoSettle(candidate.eventId, lightningReference)) {
      return {
        executed: false,
        deduped: true,
        reason: "already-settled"
      };
    }

    if (candidate.lightningRef.network !== "bitcoin") {
      await this.ledger.addAutoSettle({
        triggerObjectKind: candidate.triggerObjectKind,
        triggerObjectId: candidate.triggerObjectId,
        eventId: candidate.eventId,
        lightningReference,
        action: "pay-bolt11",
        result: "skipped",
        detail: "unsupported-network",
        createdAt: this.now()
      });
      return {
        executed: true,
        deduped: false,
        state: "skipped",
        reason: "unsupported-network"
      };
    }

    if (candidate.lightningRef.type !== "bolt11") {
      await this.ledger.addAutoSettle({
        triggerObjectKind: candidate.triggerObjectKind,
        triggerObjectId: candidate.triggerObjectId,
        eventId: candidate.eventId,
        lightningReference,
        action: "pay-bolt11",
        result: "skipped",
        detail: "unsupported-reference-type",
        createdAt: this.now()
      });
      return {
        executed: true,
        deduped: false,
        state: "skipped",
        reason: "unsupported-reference-type"
      };
    }

    try {
      const result = await this.payInvoice({
        invoice: candidate.lightningRef.reference,
        sourceRef: `${candidate.triggerObjectKind}:${candidate.triggerObjectId}:${candidate.eventId}`
      });
      await this.ledger.addAutoSettle({
        triggerObjectKind: candidate.triggerObjectKind,
        triggerObjectId: candidate.triggerObjectId,
        eventId: candidate.eventId,
        lightningReference,
        action: "pay-bolt11",
        result: "succeeded",
        paymentId: result.payment.id,
        createdAt: this.now()
      });
      return {
        executed: true,
        deduped: false,
        state: "succeeded",
        paymentId: result.payment.id
      };
    } catch (error) {
      const message = normalizeUnknownError(error).message;
      await this.ledger.addAutoSettle({
        triggerObjectKind: candidate.triggerObjectKind,
        triggerObjectId: candidate.triggerObjectId,
        eventId: candidate.eventId,
        lightningReference,
        action: "pay-bolt11",
        result: "failed",
        detail: message,
        createdAt: this.now()
      });
      return {
        executed: true,
        deduped: false,
        state: "failed",
        reason: message
      };
    }
  }

  public setRuntimeKey(keyMaterial: string | null): void {
    if (keyMaterial === null) {
      this.runtimeWalletKey = null;
      return;
    }
    const trimmed = keyMaterial.trim();
    this.runtimeWalletKey = trimmed.length > 0 ? trimmed : null;
  }

  private async assertUnlockIfConfigured(): Promise<void> {
    const configured = await this.configStore.hasEncryptedConfig();
    if (!configured) {
      return;
    }
    const key = this.getWalletKey();
    const config = await this.configStore.readConnection(key);
    if (!config) {
      throw new WalletUnavailableError("Wallet config is incomplete");
    }
  }

  private async canUnlockConfig(): Promise<boolean> {
    try {
      const key = this.getWalletKey();
      const config = await this.configStore.readConnection(key);
      return !!config;
    } catch {
      return false;
    }
  }

  private async getUnlockedAdapter(): Promise<WalletAdapter> {
    const key = this.getWalletKey();
    const config = await this.configStore.readConnection(key);
    if (!config) {
      throw new WalletUnavailableError("No wallet connection is configured");
    }

    if (config.backend !== "nwc") {
      throw new WalletUnavailableError(`Unsupported wallet backend: ${config.backend}`);
    }

    if (this.adapterCache && this.adapterCache.connectionUri === config.connectionUri) {
      return this.adapterCache.adapter;
    }

    if (this.adapterCache) {
      await this.adapterCache.adapter.disconnect();
    }

    const adapter = this.adapterFactory(config.connectionUri);
    this.adapterCache = {
      connectionUri: config.connectionUri,
      adapter
    };
    return adapter;
  }

  private getWalletKey(): string {
    if (this.runtimeWalletKey) {
      return this.runtimeWalletKey;
    }
    return getWalletKeyFromEnv(this.env);
  }
}
