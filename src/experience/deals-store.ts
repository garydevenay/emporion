import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export type DealStage =
  | "draft"
  | "negotiating"
  | "agreed"
  | "in_progress"
  | "proof_submitted"
  | "proof_accepted"
  | "settlement_pending"
  | "settled"
  | "closed";

export interface DealRecord {
  dealId: string;
  stage: DealStage;
  intent?: "buy" | "sell";
  marketplaceId?: string;
  title?: string;
  amountSats?: number;
  rootObjectKind?: "request" | "listing";
  rootObjectId?: string;
  proposalKind?: "offer" | "bid";
  proposalId?: string;
  agreementId?: string;
  contractId?: string;
  milestoneId?: string;
  evidenceId?: string;
  invoiceId?: string;
  invoiceBolt11?: string;
  paymentId?: string;
  createdAt: string;
  updatedAt: string;
}

interface DealsFile {
  deals: DealRecord[];
}

function dealStorePath(dataDir: string): string {
  return path.join(path.resolve(dataDir), "runtime", "experience", "deals.v1.json");
}

function ensureRecord(value: unknown): DealRecord {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid deal record");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.dealId !== "string" || record.dealId.trim().length === 0) {
    throw new Error("Invalid dealId in deal record");
  }
  if (typeof record.stage !== "string") {
    throw new Error("Invalid stage in deal record");
  }
  if (typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") {
    throw new Error("Invalid timestamps in deal record");
  }
  return record as unknown as DealRecord;
}

function parseDealsFile(raw: unknown): DealsFile {
  if (typeof raw !== "object" || raw === null) {
    return { deals: [] };
  }
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.deals)) {
    return { deals: [] };
  }
  return {
    deals: value.deals.map((entry) => ensureRecord(entry))
  };
}

export class DealsStore {
  private readonly filePath: string;
  private readonly deals = new Map<string, DealRecord>();

  private constructor(filePath: string) {
    this.filePath = filePath;
  }

  public static async create(dataDir: string): Promise<DealsStore> {
    const store = new DealsStore(dealStorePath(dataDir));
    await store.load();
    return store;
  }

  public list(): DealRecord[] {
    return [...this.deals.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  public get(dealId: string): DealRecord | undefined {
    return this.deals.get(dealId);
  }

  public findByRootObjectId(objectId: string): DealRecord | undefined {
    return [...this.deals.values()].find((entry) => entry.rootObjectId === objectId);
  }

  public findByProposalId(proposalId: string): DealRecord | undefined {
    return [...this.deals.values()].find((entry) => entry.proposalId === proposalId);
  }

  public findByContractId(contractId: string): DealRecord | undefined {
    return [...this.deals.values()].find((entry) => entry.contractId === contractId);
  }

  public async save(record: DealRecord): Promise<DealRecord> {
    this.deals.set(record.dealId, { ...record });
    await this.persist();
    return record;
  }

  public async update(
    dealId: string,
    updater: (current: DealRecord) => DealRecord
  ): Promise<DealRecord> {
    const current = this.deals.get(dealId);
    if (!current) {
      throw new Error(`Unknown deal: ${dealId}`);
    }
    const next = updater({ ...current });
    this.deals.set(dealId, next);
    await this.persist();
    return next;
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = parseDealsFile(JSON.parse(raw) as unknown);
      this.deals.clear();
      for (const deal of parsed.deals) {
        this.deals.set(deal.dealId, deal);
      }
    } catch {
      this.deals.clear();
    }
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const payload: DealsFile = {
      deals: this.list()
    };
    await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}

