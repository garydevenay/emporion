import { mkdir } from "node:fs/promises";
import path from "node:path";

import Corestore from "corestore";
import Hyperbee from "hyperbee";
import Hypercore from "hypercore";

import { ProtocolConflictError, ProtocolValidationError } from "../errors.js";
import type { Logger } from "../logger.js";
import { createLogger } from "../logger.js";
import { applyCompanyEvent, type CompanyState } from "./company.js";
import { applyContractEvent, type ContractState } from "./contracts.js";
import {
  applyFeedbackCredentialRefEvent,
  type FeedbackCredentialRefState
} from "./credential-reference.js";
import { verifyProtocolEnvelopeSignature, type ProtocolEnvelope } from "./envelope.js";
import { applyAgentProfileEvent, type AgentProfileState } from "./identity.js";
import {
  applyAgreementEvent,
  applyBidEvent,
  applyListingEvent,
  applyOfferEvent,
  applyProductEvent,
  applyRequestEvent,
  type AgreementState,
  type BidState,
  type ListingState,
  type OfferState,
  type ProductState,
  type RequestState
} from "./market.js";
import {
  applyDisputeCaseEvent,
  applyEvidenceBundleEvent,
  applyOracleAttestationEvent,
  type DisputeCaseState,
  type EvidenceBundleState,
  type OracleAttestationState
} from "./resolution.js";
import {
  applyMessageEvent,
  applySpaceEvent,
  applySpaceMembershipEvent,
  type MessageState,
  type SpaceMembershipState,
  type SpaceState
} from "./messaging.js";
import { safeFeedComponent, type ProtocolJsonObject } from "./shared.js";

type ObjectState =
  | AgentProfileState
  | CompanyState
  | ProductState
  | ListingState
  | RequestState
  | OfferState
  | BidState
  | AgreementState
  | FeedbackCredentialRefState
  | ContractState
  | EvidenceBundleState
  | OracleAttestationState
  | DisputeCaseState
  | SpaceState
  | SpaceMembershipState
  | MessageState;

interface ObjectCatalogRecord {
  objectKind: ProtocolEnvelope["objectKind"];
  objectId: string;
  feedName: string;
  feedKey: string;
  headEventId: string;
  subjectId: string;
  actorDid: string;
  marketplaceId: string | undefined;
  companyDid: string | undefined;
  updatedAt: string;
}

interface MarketplaceIndexEntry {
  objectKind: ProtocolEnvelope["objectKind"];
  objectId: string;
  marketplaceId: string;
  status: string;
  updatedAt: string;
}

interface SpaceIndexEntry {
  objectKind: "space" | "space-membership" | "message";
  objectId: string;
  spaceId: string;
  status: string;
  updatedAt: string;
}

interface ProtocolStateSnapshot {
  agentProfiles: Map<string, AgentProfileState>;
  companies: Map<string, CompanyState>;
  products: Map<string, ProductState>;
  listings: Map<string, ListingState>;
  requests: Map<string, RequestState>;
  offers: Map<string, OfferState>;
  bids: Map<string, BidState>;
  agreements: Map<string, AgreementState>;
  feedbackCredentialRefs: Map<string, FeedbackCredentialRefState>;
  contracts: Map<string, ContractState>;
  evidenceBundles: Map<string, EvidenceBundleState>;
  oracleAttestations: Map<string, OracleAttestationState>;
  disputes: Map<string, DisputeCaseState>;
  spaces: Map<string, SpaceState>;
  spaceMemberships: Map<string, SpaceMembershipState>;
  messages: Map<string, MessageState>;
}

function createEmptySnapshot(): ProtocolStateSnapshot {
  return {
    agentProfiles: new Map(),
    companies: new Map(),
    products: new Map(),
    listings: new Map(),
    requests: new Map(),
    offers: new Map(),
    bids: new Map(),
    agreements: new Map(),
    feedbackCredentialRefs: new Map(),
    contracts: new Map(),
    evidenceBundles: new Map(),
    oracleAttestations: new Map(),
    disputes: new Map(),
    spaces: new Map(),
    spaceMemberships: new Map(),
    messages: new Map()
  };
}

function feedNameForEnvelope(envelope: ProtocolEnvelope): string {
  return `protocol:object:${envelope.objectKind}:${safeFeedComponent(envelope.objectId)}`;
}

function stateKeyForEnvelope(envelope: ProtocolEnvelope): string {
  return `${envelope.objectKind}:${envelope.objectId}`;
}

function stateStatus(value: ObjectState): string {
  return "status" in value ? String(value.status) : "active";
}

function currentMarketplaceId(value: ObjectState): string | undefined {
  return "marketplaceId" in value ? value.marketplaceId : undefined;
}

function currentCompanyDid(value: ObjectState): string | undefined {
  if ("companyDid" in value) {
    return value.companyDid;
  }
  if ("ownerDid" in value && String(value.ownerDid).startsWith("did:emporion:company:")) {
    return value.ownerDid;
  }
  if ("sellerDid" in value && String(value.sellerDid).startsWith("did:emporion:company:")) {
    return value.sellerDid;
  }
  if ("requesterDid" in value && String(value.requesterDid).startsWith("did:emporion:company:")) {
    return value.requesterDid;
  }
  if ("proposerDid" in value && String(value.proposerDid).startsWith("did:emporion:company:")) {
    return value.proposerDid;
  }
  return undefined;
}

function currentContractId(value: ObjectState): string | undefined {
  if ("contractId" in value) {
    return value.contractId;
  }
  if ("subjectRef" in value && value.subjectRef?.objectKind === "contract") {
    return value.subjectRef.objectId;
  }
  return undefined;
}

function currentSpaceId(value: ObjectState): string | undefined {
  if ("spaceId" in value) {
    return value.spaceId;
  }
  return undefined;
}

async function clearBee(bee: Hyperbee<string, ProtocolJsonObject>): Promise<void> {
  for await (const entry of bee.createReadStream()) {
    await bee.del(entry.key);
  }
}

export class ProtocolRepository {
  private readonly store: Corestore;
  private readonly logger: Logger;
  private readonly logs: Corestore;
  private readonly stateBee: Hyperbee<string, ProtocolJsonObject>;
  private readonly catalogBee: Hyperbee<string, ProtocolJsonObject>;
  private readonly controlBee: Hyperbee<string, ProtocolJsonObject>;
  private readonly marketBee: Hyperbee<string, ProtocolJsonObject>;
  private readonly companyBee: Hyperbee<string, ProtocolJsonObject>;
  private readonly contractBee: Hyperbee<string, ProtocolJsonObject>;
  private readonly spaceBee: Hyperbee<string, ProtocolJsonObject>;
  private readonly snapshot: ProtocolStateSnapshot;

  private constructor(
    store: Corestore,
    logger: Logger,
    stateBee: Hyperbee<string, ProtocolJsonObject>,
    catalogBee: Hyperbee<string, ProtocolJsonObject>,
    controlBee: Hyperbee<string, ProtocolJsonObject>,
    marketBee: Hyperbee<string, ProtocolJsonObject>,
    companyBee: Hyperbee<string, ProtocolJsonObject>,
    contractBee: Hyperbee<string, ProtocolJsonObject>,
    spaceBee: Hyperbee<string, ProtocolJsonObject>
  ) {
    this.store = store;
    this.logger = logger;
    this.logs = store.namespace("protocol-logs");
    this.stateBee = stateBee;
    this.catalogBee = catalogBee;
    this.controlBee = controlBee;
    this.marketBee = marketBee;
    this.companyBee = companyBee;
    this.contractBee = contractBee;
    this.spaceBee = spaceBee;
    this.snapshot = createEmptySnapshot();
  }

  public static async create(dataDir: string, options?: { logger?: Logger }): Promise<ProtocolRepository> {
    await mkdir(dataDir, { recursive: true });
    const store = new Corestore(path.join(dataDir, "protocol-store"));
    await store.ready();
    const stateBee = await ProtocolRepository.openBee(store.namespace("protocol-indexes"), "state");
    const catalogBee = await ProtocolRepository.openBee(store.namespace("protocol-indexes"), "catalog");
    const controlBee = await ProtocolRepository.openBee(store.namespace("protocol-indexes"), "control");
    const marketBee = await ProtocolRepository.openBee(store.namespace("protocol-indexes"), "market");
    const companyBee = await ProtocolRepository.openBee(store.namespace("protocol-indexes"), "company");
    const contractBee = await ProtocolRepository.openBee(store.namespace("protocol-indexes"), "contract");
    const spaceBee = await ProtocolRepository.openBee(store.namespace("protocol-indexes"), "space");
    const repository = new ProtocolRepository(
      store,
      options?.logger ?? createLogger("error"),
      stateBee,
      catalogBee,
      controlBee,
      marketBee,
      companyBee,
      contractBee,
      spaceBee
    );
    await repository.hydrateSnapshotFromStateIndex();
    return repository;
  }

  private static async openBee(store: Corestore, name: string): Promise<Hyperbee<string, ProtocolJsonObject>> {
    const core = store.get({ name }) as Hypercore<Buffer>;
    await core.ready();
    const bee = new Hyperbee<string, ProtocolJsonObject>(core, {
      keyEncoding: "utf-8",
      valueEncoding: "json"
    });
    await bee.ready();
    return bee;
  }

  public async appendEnvelope(envelope: ProtocolEnvelope): Promise<void> {
    await verifyProtocolEnvelopeSignature(envelope);
    const nextState = this.applyToSnapshot(envelope);
    const feed = await this.openObjectLog(envelope);
    await feed.append(envelope as unknown as ProtocolJsonObject);

    const catalogRecord: ObjectCatalogRecord = {
      objectKind: envelope.objectKind,
      objectId: envelope.objectId,
      feedName: feedNameForEnvelope(envelope),
      feedKey: feed.key.toString("hex"),
      headEventId: envelope.eventId,
      subjectId: envelope.subjectId,
      actorDid: envelope.actorDid,
      marketplaceId: currentMarketplaceId(nextState),
      companyDid: currentCompanyDid(nextState),
      updatedAt: envelope.issuedAt
    };

    await this.catalogBee.put(stateKeyForEnvelope(envelope), catalogRecord as unknown as ProtocolJsonObject);
    await this.stateBee.put(stateKeyForEnvelope(envelope), nextState as unknown as ProtocolJsonObject);
    await this.controlBee.put(`${envelope.actorDid}:${envelope.objectKind}:${envelope.objectId}`, catalogRecord as unknown as ProtocolJsonObject);

    const marketplaceId = currentMarketplaceId(nextState);
    if (marketplaceId) {
      const marketKey = `${marketplaceId}:${envelope.objectKind}:${envelope.objectId}`;
      if (stateStatus(nextState) === "open" || stateStatus(nextState) === "published" || stateStatus(nextState) === "active") {
        const marketEntry: MarketplaceIndexEntry = {
          objectKind: envelope.objectKind,
          objectId: envelope.objectId,
          marketplaceId,
          status: stateStatus(nextState),
          updatedAt: envelope.issuedAt
        };
        await this.marketBee.put(marketKey, marketEntry as unknown as ProtocolJsonObject);
      } else {
        await this.marketBee.del(marketKey);
      }
    }

    const companyDid = currentCompanyDid(nextState);
    if (companyDid) {
      await this.companyBee.put(`${companyDid}:${envelope.objectKind}:${envelope.objectId}`, catalogRecord as unknown as ProtocolJsonObject);
    }

    const contractId = currentContractId(nextState);
    if (contractId) {
      await this.contractBee.put(`${contractId}:${envelope.objectKind}:${envelope.objectId}`, catalogRecord as unknown as ProtocolJsonObject);
    }

    const spaceId = currentSpaceId(nextState);
    if (spaceId) {
      const status = stateStatus(nextState);
      const entry: SpaceIndexEntry = {
        objectKind: envelope.objectKind === "space-membership" || envelope.objectKind === "message" ? envelope.objectKind : "space",
        objectId: envelope.objectId,
        spaceId,
        status,
        updatedAt: envelope.issuedAt
      };
      await this.spaceBee.put(`${spaceId}:${envelope.objectKind}:${envelope.objectId}`, entry as unknown as ProtocolJsonObject);
    }

    this.logger.debug("Appended protocol envelope", {
      objectKind: envelope.objectKind,
      objectId: envelope.objectId,
      eventKind: envelope.eventKind,
      eventId: envelope.eventId
    });
  }

  public getSnapshot(): Readonly<ProtocolStateSnapshot> {
    return this.snapshot;
  }

  public async rebuildFromLogs(): Promise<void> {
    const nextSnapshot = createEmptySnapshot();
    this.snapshot.agentProfiles.clear();
    this.snapshot.companies.clear();
    this.snapshot.products.clear();
    this.snapshot.listings.clear();
    this.snapshot.requests.clear();
    this.snapshot.offers.clear();
    this.snapshot.bids.clear();
    this.snapshot.agreements.clear();
    this.snapshot.feedbackCredentialRefs.clear();
    this.snapshot.contracts.clear();
    this.snapshot.evidenceBundles.clear();
    this.snapshot.oracleAttestations.clear();
    this.snapshot.disputes.clear();
    this.snapshot.spaces.clear();
    this.snapshot.spaceMemberships.clear();
    this.snapshot.messages.clear();
    await clearBee(this.stateBee);
    await clearBee(this.marketBee);
    await clearBee(this.companyBee);
    await clearBee(this.contractBee);
    await clearBee(this.spaceBee);
    await clearBee(this.controlBee);

    for await (const entry of this.catalogBee.createReadStream()) {
      const catalogRecord = entry.value as unknown as ObjectCatalogRecord;
      const log = this.logs.get({
        name: catalogRecord.feedName,
        valueEncoding: "json"
      }) as Hypercore<ProtocolJsonObject>;
      await log.ready();

      for await (const rawEnvelope of log.createReadStream()) {
        const envelope = rawEnvelope as unknown as ProtocolEnvelope;
        const nextState = this.applyToSnapshot(envelope, nextSnapshot);
        await this.stateBee.put(stateKeyForEnvelope(envelope), nextState as unknown as ProtocolJsonObject);
      }
    }

    for (const [key, value] of nextSnapshot.agentProfiles) {
      this.snapshot.agentProfiles.set(key, value);
    }
    for (const [key, value] of nextSnapshot.companies) {
      this.snapshot.companies.set(key, value);
      await this.companyBee.put(`${value.companyDid}:company:${value.companyDid}`, value as unknown as ProtocolJsonObject);
    }
    for (const [key, value] of nextSnapshot.products) {
      this.snapshot.products.set(key, value);
      if (value.status === "published") {
        await this.marketBee.put(
          `${value.marketplaceId}:product:${value.objectId}`,
          {
            objectKind: "product",
            objectId: value.objectId,
            marketplaceId: value.marketplaceId,
            status: value.status,
            updatedAt: value.latestEventId
          } as unknown as ProtocolJsonObject
        );
      }
    }
    for (const [key, value] of nextSnapshot.listings) {
      this.snapshot.listings.set(key, value);
      if (value.status === "open") {
        await this.marketBee.put(
          `${value.marketplaceId}:listing:${value.objectId}`,
          {
            objectKind: "listing",
            objectId: value.objectId,
            marketplaceId: value.marketplaceId,
            status: value.status,
            updatedAt: value.latestEventId
          } as unknown as ProtocolJsonObject
        );
      }
    }
    for (const [key, value] of nextSnapshot.requests) {
      this.snapshot.requests.set(key, value);
      if (value.status === "open") {
        await this.marketBee.put(
          `${value.marketplaceId}:request:${value.objectId}`,
          {
            objectKind: "request",
            objectId: value.objectId,
            marketplaceId: value.marketplaceId,
            status: value.status,
            updatedAt: value.latestEventId
          } as unknown as ProtocolJsonObject
        );
      }
    }
    for (const [key, value] of nextSnapshot.offers) {
      this.snapshot.offers.set(key, value);
      if (value.status === "open") {
        await this.marketBee.put(
          `${value.marketplaceId}:offer:${value.objectId}`,
          {
            objectKind: "offer",
            objectId: value.objectId,
            marketplaceId: value.marketplaceId,
            status: value.status,
            updatedAt: value.latestEventId
          } as unknown as ProtocolJsonObject
        );
      }
    }
    for (const [key, value] of nextSnapshot.bids) {
      this.snapshot.bids.set(key, value);
      if (value.status === "open") {
        await this.marketBee.put(
          `${value.marketplaceId}:bid:${value.objectId}`,
          {
            objectKind: "bid",
            objectId: value.objectId,
            marketplaceId: value.marketplaceId,
            status: value.status,
            updatedAt: value.latestEventId
          } as unknown as ProtocolJsonObject
        );
      }
    }
    for (const [key, value] of nextSnapshot.agreements) {
      this.snapshot.agreements.set(key, value);
      if (value.status === "active") {
        await this.marketBee.put(
          `${value.marketplaceId}:agreement:${value.objectId}`,
          {
            objectKind: "agreement",
            objectId: value.objectId,
            marketplaceId: value.marketplaceId,
            status: value.status,
            updatedAt: value.latestEventId
          } as unknown as ProtocolJsonObject
        );
      }
    }
    for (const [key, value] of nextSnapshot.feedbackCredentialRefs) {
      this.snapshot.feedbackCredentialRefs.set(key, value);
    }
    for (const [key, value] of nextSnapshot.contracts) {
      this.snapshot.contracts.set(key, value);
      await this.contractBee.put(`${value.contractId}:contract:${value.contractId}`, value as unknown as ProtocolJsonObject);
    }
    for (const [key, value] of nextSnapshot.evidenceBundles) {
      this.snapshot.evidenceBundles.set(key, value);
      await this.contractBee.put(
        `${value.contractId}:evidence-bundle:${value.objectId}`,
        value as unknown as ProtocolJsonObject
      );
    }
    for (const [key, value] of nextSnapshot.oracleAttestations) {
      this.snapshot.oracleAttestations.set(key, value);
      if (value.subjectRef.objectKind === "contract") {
        await this.contractBee.put(
          `${value.subjectRef.objectId}:oracle-attestation:${value.objectId}`,
          value as unknown as ProtocolJsonObject
        );
      }
    }
    for (const [key, value] of nextSnapshot.disputes) {
      this.snapshot.disputes.set(key, value);
      await this.contractBee.put(`${value.contractId}:dispute-case:${value.objectId}`, value as unknown as ProtocolJsonObject);
    }
    for (const [key, value] of nextSnapshot.spaces) {
      this.snapshot.spaces.set(key, value);
      await this.spaceBee.put(
        `${value.spaceId}:space:${value.objectId}`,
        {
          objectKind: "space",
          objectId: value.objectId,
          spaceId: value.spaceId,
          status: value.status,
          updatedAt: value.latestEventId
        } as unknown as ProtocolJsonObject
      );
    }
    for (const [key, value] of nextSnapshot.spaceMemberships) {
      this.snapshot.spaceMemberships.set(key, value);
      await this.spaceBee.put(
        `${value.spaceId}:space-membership:${value.objectId}`,
        {
          objectKind: "space-membership",
          objectId: value.objectId,
          spaceId: value.spaceId,
          status: value.status,
          updatedAt: value.latestEventId
        } as unknown as ProtocolJsonObject
      );
    }
    for (const [key, value] of nextSnapshot.messages) {
      this.snapshot.messages.set(key, value);
      if (value.status !== "deleted") {
        await this.spaceBee.put(
          `${value.spaceId}:message:${value.objectId}`,
          {
            objectKind: "message",
            objectId: value.objectId,
            spaceId: value.spaceId,
            status: value.status,
            updatedAt: value.latestEventId
          } as unknown as ProtocolJsonObject
        );
      }
    }
  }

  public async listMarketplaceEntries(marketplaceId: string): Promise<MarketplaceIndexEntry[]> {
    const results: MarketplaceIndexEntry[] = [];
    for await (const entry of this.marketBee.createReadStream({
      gte: `${marketplaceId}:`,
      lt: `${marketplaceId};`
    })) {
      results.push(entry.value as unknown as MarketplaceIndexEntry);
    }
    return results;
  }

  public async listContractEntries(contractId: string): Promise<ObjectCatalogRecord[]> {
    const results: ObjectCatalogRecord[] = [];
    for await (const entry of this.contractBee.createReadStream({
      gte: `${contractId}:`,
      lt: `${contractId};`
    })) {
      results.push(entry.value as unknown as ObjectCatalogRecord);
    }
    return results;
  }

  public async listSpaceEntries(spaceId: string): Promise<SpaceIndexEntry[]> {
    const results: SpaceIndexEntry[] = [];
    for await (const entry of this.spaceBee.createReadStream({
      gte: `${spaceId}:`,
      lt: `${spaceId};`
    })) {
      results.push(entry.value as unknown as SpaceIndexEntry);
    }
    return results;
  }

  public async listCatalogRecords(): Promise<ObjectCatalogRecord[]> {
    const results: ObjectCatalogRecord[] = [];
    for await (const entry of this.catalogBee.createReadStream()) {
      results.push(entry.value as unknown as ObjectCatalogRecord);
    }
    return results;
  }

  public async readObjectState(objectKind: ProtocolEnvelope["objectKind"], objectId: string): Promise<ObjectState | null> {
    const entry = await this.stateBee.get(`${objectKind}:${objectId}`);
    return (entry?.value as unknown as ObjectState | undefined) ?? null;
  }

  public async close(): Promise<void> {
    await this.stateBee.close();
    await this.catalogBee.close();
    await this.controlBee.close();
    await this.marketBee.close();
    await this.companyBee.close();
    await this.contractBee.close();
    await this.spaceBee.close();
    await this.store.close();
  }

  private async openObjectLog(envelope: ProtocolEnvelope): Promise<Hypercore<ProtocolJsonObject>> {
    const feed = this.logs.get({
      name: feedNameForEnvelope(envelope),
      valueEncoding: "json"
    }) as Hypercore<ProtocolJsonObject>;
    await feed.ready();
    return feed;
  }

  private async hydrateSnapshotFromStateIndex(): Promise<void> {
    for await (const entry of this.stateBee.createReadStream()) {
      const separatorIndex = entry.key.indexOf(":");
      if (separatorIndex === -1) {
        continue;
      }

      const objectKind = entry.key.slice(0, separatorIndex) as ProtocolEnvelope["objectKind"];
      switch (objectKind) {
        case "agent-profile":
          this.snapshot.agentProfiles.set(entry.key.slice(separatorIndex + 1), entry.value as unknown as AgentProfileState);
          break;
        case "company":
          this.snapshot.companies.set(entry.key.slice(separatorIndex + 1), entry.value as unknown as CompanyState);
          break;
        case "product":
          this.snapshot.products.set(entry.key.slice(separatorIndex + 1), entry.value as unknown as ProductState);
          break;
        case "listing":
          this.snapshot.listings.set(entry.key.slice(separatorIndex + 1), entry.value as unknown as ListingState);
          break;
        case "request":
          this.snapshot.requests.set(entry.key.slice(separatorIndex + 1), entry.value as unknown as RequestState);
          break;
        case "offer":
          this.snapshot.offers.set(entry.key.slice(separatorIndex + 1), entry.value as unknown as OfferState);
          break;
        case "bid":
          this.snapshot.bids.set(entry.key.slice(separatorIndex + 1), entry.value as unknown as BidState);
          break;
        case "agreement":
          this.snapshot.agreements.set(entry.key.slice(separatorIndex + 1), entry.value as unknown as AgreementState);
          break;
        case "feedback-credential-ref":
          this.snapshot.feedbackCredentialRefs.set(
            entry.key.slice(separatorIndex + 1),
            entry.value as unknown as FeedbackCredentialRefState
          );
          break;
        case "contract":
          this.snapshot.contracts.set(entry.key.slice(separatorIndex + 1), entry.value as unknown as ContractState);
          break;
        case "evidence-bundle":
          this.snapshot.evidenceBundles.set(entry.key.slice(separatorIndex + 1), entry.value as unknown as EvidenceBundleState);
          break;
        case "oracle-attestation":
          this.snapshot.oracleAttestations.set(
            entry.key.slice(separatorIndex + 1),
            entry.value as unknown as OracleAttestationState
          );
          break;
        case "dispute-case":
          this.snapshot.disputes.set(entry.key.slice(separatorIndex + 1), entry.value as unknown as DisputeCaseState);
          break;
        case "space":
          this.snapshot.spaces.set(entry.key.slice(separatorIndex + 1), entry.value as unknown as SpaceState);
          break;
        case "space-membership":
          this.snapshot.spaceMemberships.set(
            entry.key.slice(separatorIndex + 1),
            entry.value as unknown as SpaceMembershipState
          );
          break;
        case "message":
          this.snapshot.messages.set(entry.key.slice(separatorIndex + 1), entry.value as unknown as MessageState);
          break;
        default:
          this.logger.warn("Skipping unknown state entry during snapshot hydration", { key: entry.key });
      }
    }
  }

  private applyToSnapshot(envelope: ProtocolEnvelope, target = this.snapshot): ObjectState {
    switch (envelope.objectKind) {
      case "agent-profile": {
        const current = target.agentProfiles.get(envelope.objectId);
        const next = applyAgentProfileEvent(current, envelope);
        target.agentProfiles.set(envelope.objectId, next);
        return next;
      }
      case "company": {
        const current = target.companies.get(envelope.objectId);
        const next = applyCompanyEvent(current, envelope);
        target.companies.set(envelope.objectId, next);
        return next;
      }
      case "product": {
        const current = target.products.get(envelope.objectId);
        const next = applyProductEvent(current, envelope);
        target.products.set(envelope.objectId, next);
        return next;
      }
      case "listing": {
        const current = target.listings.get(envelope.objectId);
        const next = applyListingEvent(current, envelope);
        target.listings.set(envelope.objectId, next);
        return next;
      }
      case "request": {
        const current = target.requests.get(envelope.objectId);
        const next = applyRequestEvent(current, envelope);
        target.requests.set(envelope.objectId, next);
        return next;
      }
      case "offer": {
        const current = target.offers.get(envelope.objectId);
        const next = applyOfferEvent(current, envelope);
        target.offers.set(envelope.objectId, next);
        return next;
      }
      case "bid": {
        const current = target.bids.get(envelope.objectId);
        const next = applyBidEvent(current, envelope);
        target.bids.set(envelope.objectId, next);
        return next;
      }
      case "agreement": {
        const current = target.agreements.get(envelope.objectId);
        const next = applyAgreementEvent(current, envelope, {
          offerStates: target.offers,
          bidStates: target.bids,
          listingStates: target.listings,
          requestStates: target.requests
        });
        target.agreements.set(envelope.objectId, next);
        return next;
      }
      case "feedback-credential-ref": {
        const current = target.feedbackCredentialRefs.get(envelope.objectId);
        const next = applyFeedbackCredentialRefEvent(current, envelope);
        target.feedbackCredentialRefs.set(envelope.objectId, next);
        return next;
      }
      case "contract": {
        const current = target.contracts.get(envelope.objectId);
        const next = applyContractEvent(current, envelope, {
          agreements: target.agreements,
          listings: target.listings,
          requests: target.requests,
          offers: target.offers,
          bids: target.bids
        });
        target.contracts.set(envelope.objectId, next);
        return next;
      }
      case "evidence-bundle": {
        const current = target.evidenceBundles.get(envelope.objectId);
        const next = applyEvidenceBundleEvent(current, envelope, {
          contracts: target.contracts
        });
        target.evidenceBundles.set(envelope.objectId, next);
        return next;
      }
      case "oracle-attestation": {
        const current = target.oracleAttestations.get(envelope.objectId);
        const next = applyOracleAttestationEvent(current, envelope, {
          contracts: target.contracts,
          evidenceBundles: target.evidenceBundles,
          disputes: target.disputes
        });
        target.oracleAttestations.set(envelope.objectId, next);
        return next;
      }
      case "dispute-case": {
        const current = target.disputes.get(envelope.objectId);
        const next = applyDisputeCaseEvent(current, envelope, {
          contracts: target.contracts,
          evidenceBundles: target.evidenceBundles,
          oracleAttestations: target.oracleAttestations
        });
        target.disputes.set(envelope.objectId, next);
        return next;
      }
      case "space": {
        const current = target.spaces.get(envelope.objectId);
        const next = applySpaceEvent(current, envelope);
        target.spaces.set(envelope.objectId, next);
        return next;
      }
      case "space-membership": {
        const current = target.spaceMemberships.get(envelope.objectId);
        const next = applySpaceMembershipEvent(current, envelope, {
          spaces: target.spaces,
          memberships: target.spaceMemberships
        });
        target.spaceMemberships.set(envelope.objectId, next);
        return next;
      }
      case "message": {
        const current = target.messages.get(envelope.objectId);
        const next = applyMessageEvent(current, envelope, {
          spaces: target.spaces,
          memberships: target.spaceMemberships
        });
        target.messages.set(envelope.objectId, next);
        return next;
      }
      default:
        throw new ProtocolValidationError(`Unsupported protocol object kind: ${(envelope as { objectKind: string }).objectKind}`);
    }
  }
}
