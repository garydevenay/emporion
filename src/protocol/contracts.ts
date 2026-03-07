import { ProtocolConflictError, ProtocolValidationError } from "../errors.js";
import type { ProtocolEnvelope } from "./envelope.js";
import { assertIsoTimestamp, type ProtocolJsonObject } from "./shared.js";
import type { AgreementState, BidState, ListingState, OfferState, RequestState } from "./market.js";

export type ContractOriginKind = "agreement" | "listing" | "request" | "offer" | "bid";
export type ProofMode = "artifact-verifiable" | "oracle-attested" | "counterparty-acceptance" | "hybrid";
export type ResolutionMode = "deterministic" | "oracle" | "mutual" | "hybrid";
export type SettlementAdapterType =
  | "external-payment-ref"
  | "lightning-hold-invoice"
  | "bolt12-offer"
  | "dlc-outcome"
  | "company-reserve-lock";
export type SettlementAdapterNetwork = "bitcoin" | "testnet" | "signet" | "regtest" | "offchain" | "internal";

export interface OriginRef {
  objectKind: ContractOriginKind;
  objectId: string;
}

export interface ArtifactRef {
  artifactId: string;
  hash: string;
  mediaType?: string;
  uri?: string;
}

export interface VerifierRef {
  verifierId: string;
  verifierKind: "deterministic" | "oracle-service" | "human-review";
  verifierDid?: string;
  algorithm?: string;
  endpointUri?: string;
}

export interface OracleQuorumPolicy {
  oracleDids: string[];
  quorum: number;
}

export interface ProofPolicy {
  allowedModes: ProofMode[];
  verifierRefs: VerifierRef[];
  minArtifacts?: number;
  requireCounterpartyAcceptance: boolean;
}

export interface SettlementAdapterRef {
  adapterType: SettlementAdapterType;
  adapterId: string;
  network: SettlementAdapterNetwork;
  artifactRefs: string[];
  statusRef?: string;
}

export interface SettlementPolicy {
  adapters: SettlementAdapterRef[];
  releaseCondition: "milestone-accepted" | "contract-completed" | "oracle-ruled" | "manual";
}

export interface ResolutionPolicy {
  mode: ResolutionMode;
  deterministicVerifierIds: string[];
  oracleQuorum?: OracleQuorumPolicy;
  fallbackMode?: "deterministic" | "oracle" | "mutual";
}

export interface DeadlinePolicy {
  contractExpiresAt?: string;
  milestoneDeadlines: Record<string, string>;
  gracePeriodHours?: number;
}

export interface DeliverableSchema {
  kind: "generic" | "artifact" | "oracle-claim";
  schemaUri?: string;
  requiredArtifactKinds: string[];
}

export interface MilestoneDefinition {
  milestoneId: string;
  title: string;
  description?: string;
  deliverableSchema: DeliverableSchema;
  proofPolicy: ProofPolicy;
  settlementAdapters: SettlementAdapterRef[];
}

export interface ContractCreatedPayload {
  originRef: OriginRef;
  parties: string[];
  sponsorDid?: string;
  companyDid?: string;
  scope: string;
  milestones: MilestoneDefinition[];
  deliverableSchema: DeliverableSchema;
  proofPolicy: ProofPolicy;
  resolutionPolicy: ResolutionPolicy;
  settlementPolicy: SettlementPolicy;
  deadlinePolicy: DeadlinePolicy;
}

export interface ContractMilestoneState extends MilestoneDefinition {
  status: "pending" | "open" | "submitted" | "accepted" | "rejected";
  evidenceBundleIds: string[];
  oracleAttestationIds: string[];
  acceptedBy?: string;
  rejectedBy?: string;
  rejectionReason?: string;
  submittedBy?: string;
}

export interface ContractState {
  objectId: string;
  contractId: string;
  originRef: OriginRef;
  parties: string[];
  sponsorDid?: string;
  companyDid?: string;
  scope: string;
  deliverableSchema: DeliverableSchema;
  proofPolicy: ProofPolicy;
  resolutionPolicy: ResolutionPolicy;
  settlementPolicy: SettlementPolicy;
  deadlinePolicy: DeadlinePolicy;
  milestones: Record<string, ContractMilestoneState>;
  status: "active" | "paused" | "completed" | "canceled" | "disputed";
  latestEventId: string;
  eventIds: string[];
}

export type ContractEventKind =
  | "contract.created"
  | "contract.milestone-opened"
  | "contract.milestone-submitted"
  | "contract.milestone-accepted"
  | "contract.milestone-rejected"
  | "contract.paused"
  | "contract.resumed"
  | "contract.completed"
  | "contract.canceled"
  | "contract.disputed";

function assertNonEmpty(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new ProtocolValidationError(`${fieldName} must not be blank`);
  }
}

function assertUniqueStrings(values: string[], fieldName: string): string[] {
  if (values.length === 0) {
    throw new ProtocolValidationError(`${fieldName} must contain at least one entry`);
  }
  for (const value of values) {
    assertNonEmpty(value, fieldName);
  }
  return [...new Set(values)].sort();
}

function assertHexHash(value: string, fieldName: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new ProtocolValidationError(`${fieldName} must be a 32-byte hex hash`);
  }
}

function validateArtifactRef(ref: ArtifactRef, fieldName: string): void {
  assertNonEmpty(ref.artifactId, `${fieldName}.artifactId`);
  assertHexHash(ref.hash, `${fieldName}.hash`);
}

function validateVerifierRef(ref: VerifierRef, fieldName: string): void {
  assertNonEmpty(ref.verifierId, `${fieldName}.verifierId`);
  if (ref.verifierDid) {
    assertNonEmpty(ref.verifierDid, `${fieldName}.verifierDid`);
  }
}

function validateProofPolicy(policy: ProofPolicy, fieldName: string): void {
  if (policy.allowedModes.length === 0) {
    throw new ProtocolValidationError(`${fieldName}.allowedModes must contain at least one mode`);
  }
  if (policy.minArtifacts !== undefined && (!Number.isInteger(policy.minArtifacts) || policy.minArtifacts < 0)) {
    throw new ProtocolValidationError(`${fieldName}.minArtifacts must be a non-negative integer`);
  }
  for (const verifierRef of policy.verifierRefs) {
    validateVerifierRef(verifierRef, `${fieldName}.verifierRefs`);
  }
}

function validateSettlementAdapterRef(ref: SettlementAdapterRef, fieldName: string): void {
  assertNonEmpty(ref.adapterId, `${fieldName}.adapterId`);
  if (ref.artifactRefs.some((entry) => entry.trim().length === 0)) {
    throw new ProtocolValidationError(`${fieldName}.artifactRefs must not contain blank values`);
  }
}

function validateSettlementPolicy(policy: SettlementPolicy, fieldName: string): void {
  for (const [index, adapter] of policy.adapters.entries()) {
    validateSettlementAdapterRef(adapter, `${fieldName}.adapters[${index}]`);
  }
}

function validateResolutionPolicy(policy: ResolutionPolicy, fieldName: string): void {
  if (policy.mode === "deterministic" || policy.mode === "hybrid") {
    if (policy.deterministicVerifierIds.length === 0) {
      throw new ProtocolValidationError(`${fieldName}.deterministicVerifierIds must not be empty`);
    }
  }
  if (policy.mode === "oracle" || policy.mode === "hybrid") {
    if (!policy.oracleQuorum) {
      throw new ProtocolValidationError(`${fieldName}.oracleQuorum is required for oracle or hybrid modes`);
    }
    if (policy.oracleQuorum.oracleDids.length === 0) {
      throw new ProtocolValidationError(`${fieldName}.oracleQuorum.oracleDids must not be empty`);
    }
    if (!Number.isInteger(policy.oracleQuorum.quorum) || policy.oracleQuorum.quorum <= 0) {
      throw new ProtocolValidationError(`${fieldName}.oracleQuorum.quorum must be a positive integer`);
    }
    if (policy.oracleQuorum.quorum > policy.oracleQuorum.oracleDids.length) {
      throw new ProtocolValidationError(`${fieldName}.oracleQuorum.quorum cannot exceed oracleDids length`);
    }
  }
}

function validateDeliverableSchema(schema: DeliverableSchema, fieldName: string): void {
  if (schema.schemaUri) {
    assertNonEmpty(schema.schemaUri, `${fieldName}.schemaUri`);
  }
  if (schema.requiredArtifactKinds.some((entry) => entry.trim().length === 0)) {
    throw new ProtocolValidationError(`${fieldName}.requiredArtifactKinds must not contain blank values`);
  }
}

function validateMilestoneDefinition(definition: MilestoneDefinition, fieldName: string): void {
  assertNonEmpty(definition.milestoneId, `${fieldName}.milestoneId`);
  assertNonEmpty(definition.title, `${fieldName}.title`);
  validateDeliverableSchema(definition.deliverableSchema, `${fieldName}.deliverableSchema`);
  validateProofPolicy(definition.proofPolicy, `${fieldName}.proofPolicy`);
  for (const [index, adapter] of definition.settlementAdapters.entries()) {
    validateSettlementAdapterRef(adapter, `${fieldName}.settlementAdapters[${index}]`);
  }
}

function validateDeadlinePolicy(policy: DeadlinePolicy, milestones: MilestoneDefinition[], fieldName: string): void {
  if (policy.contractExpiresAt) {
    assertIsoTimestamp(policy.contractExpiresAt, `${fieldName}.contractExpiresAt`);
  }
  if (policy.gracePeriodHours !== undefined && (!Number.isInteger(policy.gracePeriodHours) || policy.gracePeriodHours < 0)) {
    throw new ProtocolValidationError(`${fieldName}.gracePeriodHours must be a non-negative integer`);
  }
  for (const milestone of milestones) {
    const deadline = policy.milestoneDeadlines[milestone.milestoneId];
    if (deadline !== undefined) {
      assertIsoTimestamp(deadline, `${fieldName}.milestoneDeadlines.${milestone.milestoneId}`);
    }
  }
}

function createMilestoneState(definition: MilestoneDefinition): ContractMilestoneState {
  return {
    ...definition,
    status: "pending",
    evidenceBundleIds: [],
    oracleAttestationIds: []
  };
}

function ensureLatestPredecessor(state: ContractState | undefined, envelope: ProtocolEnvelope): void {
  if (!state) {
    if (envelope.previousEventIds.length !== 0) {
      throw new ProtocolConflictError("contract.created must not reference previous events");
    }
    return;
  }
  if (envelope.previousEventIds.length === 0 || !envelope.previousEventIds.includes(state.latestEventId)) {
    throw new ProtocolConflictError("Contract events must reference the latest event");
  }
}

function assertParty(state: ContractState, actorDid: string): void {
  if (!state.parties.includes(actorDid)) {
    throw new ProtocolConflictError("Contract event actor must be a party to the contract");
  }
}

function lookupMilestone(state: ContractState, milestoneId: string): ContractMilestoneState {
  const milestone = state.milestones[milestoneId];
  if (!milestone) {
    throw new ProtocolConflictError(`Unknown contract milestone: ${milestoneId}`);
  }
  return milestone;
}

function updateMilestone(
  state: ContractState,
  milestoneId: string,
  updater: (milestone: ContractMilestoneState) => ContractMilestoneState
): Record<string, ContractMilestoneState> {
  const milestone = lookupMilestone(state, milestoneId);
  return {
    ...state.milestones,
    [milestoneId]: updater(milestone)
  };
}

function validateCreatedPayload(payload: ContractCreatedPayload): ContractCreatedPayload {
  assertNonEmpty(payload.originRef.objectId, "ContractCreatedPayload.originRef.objectId");
  payload.parties = assertUniqueStrings(payload.parties, "ContractCreatedPayload.parties");
  if (payload.sponsorDid) {
    assertNonEmpty(payload.sponsorDid, "ContractCreatedPayload.sponsorDid");
  }
  if (payload.companyDid) {
    assertNonEmpty(payload.companyDid, "ContractCreatedPayload.companyDid");
  }
  assertNonEmpty(payload.scope, "ContractCreatedPayload.scope");
  if (payload.milestones.length === 0) {
    throw new ProtocolValidationError("ContractCreatedPayload.milestones must not be empty");
  }
  const seenMilestones = new Set<string>();
  for (const [index, milestone] of payload.milestones.entries()) {
    validateMilestoneDefinition(milestone, `ContractCreatedPayload.milestones[${index}]`);
    if (seenMilestones.has(milestone.milestoneId)) {
      throw new ProtocolValidationError(`ContractCreatedPayload contains duplicate milestoneId ${milestone.milestoneId}`);
    }
    seenMilestones.add(milestone.milestoneId);
  }
  validateDeliverableSchema(payload.deliverableSchema, "ContractCreatedPayload.deliverableSchema");
  validateProofPolicy(payload.proofPolicy, "ContractCreatedPayload.proofPolicy");
  validateResolutionPolicy(payload.resolutionPolicy, "ContractCreatedPayload.resolutionPolicy");
  validateSettlementPolicy(payload.settlementPolicy, "ContractCreatedPayload.settlementPolicy");
  validateDeadlinePolicy(payload.deadlinePolicy, payload.milestones, "ContractCreatedPayload.deadlinePolicy");
  return payload;
}

function validateOriginRef(
  payload: ContractCreatedPayload,
  refs: {
    agreements: Map<string, AgreementState>;
    listings: Map<string, ListingState>;
    requests: Map<string, RequestState>;
    offers: Map<string, OfferState>;
    bids: Map<string, BidState>;
  }
): void {
  switch (payload.originRef.objectKind) {
    case "agreement":
      if (!refs.agreements.get(payload.originRef.objectId)) {
        throw new ProtocolConflictError("Contract origin agreement does not exist");
      }
      break;
    case "listing":
      if (!refs.listings.get(payload.originRef.objectId)) {
        throw new ProtocolConflictError("Contract origin listing does not exist");
      }
      break;
    case "request":
      if (!refs.requests.get(payload.originRef.objectId)) {
        throw new ProtocolConflictError("Contract origin request does not exist");
      }
      break;
    case "offer": {
      const offer = refs.offers.get(payload.originRef.objectId);
      if (!offer) {
        throw new ProtocolConflictError("Contract origin offer does not exist");
      }
      if (offer.status !== "accepted") {
        throw new ProtocolConflictError("Contract origin offer must be accepted");
      }
      break;
    }
    case "bid": {
      const bid = refs.bids.get(payload.originRef.objectId);
      if (!bid) {
        throw new ProtocolConflictError("Contract origin bid does not exist");
      }
      if (bid.status !== "accepted") {
        throw new ProtocolConflictError("Contract origin bid must be accepted");
      }
      break;
    }
  }
}

function milestoneHasProof(milestone: ContractMilestoneState): boolean {
  return (
    milestone.evidenceBundleIds.length > 0 ||
    milestone.oracleAttestationIds.length > 0 ||
    (milestone.proofPolicy.allowedModes.includes("counterparty-acceptance") && milestone.acceptedBy !== undefined)
  );
}

export function applyContractEvent(
  currentState: ContractState | undefined,
  envelope: ProtocolEnvelope,
  refs: {
    agreements: Map<string, AgreementState>;
    listings: Map<string, ListingState>;
    requests: Map<string, RequestState>;
    offers: Map<string, OfferState>;
    bids: Map<string, BidState>;
  }
): ContractState {
  if (envelope.objectKind !== "contract") {
    throw new ProtocolValidationError("Envelope is not a contract event");
  }

  ensureLatestPredecessor(currentState, envelope);

  if (!currentState) {
    if (envelope.eventKind !== "contract.created") {
      throw new ProtocolConflictError("The first contract event must be contract.created");
    }
    const payload = validateCreatedPayload(envelope.payload as unknown as ContractCreatedPayload);
    validateOriginRef(payload, refs);
    if (!payload.parties.includes(envelope.actorDid)) {
      throw new ProtocolConflictError("Contract creator must be included in the contract parties");
    }

    return {
      objectId: envelope.objectId,
      contractId: envelope.objectId,
      originRef: payload.originRef,
      parties: payload.parties,
      ...(payload.sponsorDid ? { sponsorDid: payload.sponsorDid } : {}),
      ...(payload.companyDid ? { companyDid: payload.companyDid } : {}),
      scope: payload.scope,
      deliverableSchema: payload.deliverableSchema,
      proofPolicy: payload.proofPolicy,
      resolutionPolicy: payload.resolutionPolicy,
      settlementPolicy: payload.settlementPolicy,
      deadlinePolicy: payload.deadlinePolicy,
      milestones: Object.fromEntries(payload.milestones.map((milestone) => [milestone.milestoneId, createMilestoneState(milestone)])),
      status: "active",
      latestEventId: envelope.eventId,
      eventIds: [envelope.eventId]
    };
  }

  if (envelope.objectId !== currentState.contractId || envelope.subjectId !== currentState.contractId) {
    throw new ProtocolConflictError("Contract events must target the contractId");
  }
  assertParty(currentState, envelope.actorDid);

  switch (envelope.eventKind as ContractEventKind) {
    case "contract.milestone-opened": {
      const milestoneId = String((envelope.payload as Record<string, unknown>).milestoneId ?? "");
      const milestones = updateMilestone(currentState, milestoneId, (milestone) => {
        if (milestone.status !== "pending" && milestone.status !== "rejected") {
          throw new ProtocolConflictError("Only pending or rejected milestones can be opened");
        }
        const nextMilestone: ContractMilestoneState = {
          ...milestone,
          status: "open"
        };
        delete nextMilestone.rejectedBy;
        delete nextMilestone.rejectionReason;
        return nextMilestone;
      });
      return {
        ...currentState,
        milestones,
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    case "contract.milestone-submitted": {
      const payload = envelope.payload as {
        milestoneId: string;
        evidenceBundleIds?: string[];
        oracleAttestationIds?: string[];
      };
      const milestones = updateMilestone(currentState, payload.milestoneId, (milestone) => {
        if (milestone.status !== "open" && milestone.status !== "rejected") {
          throw new ProtocolConflictError("Only open or rejected milestones can be submitted");
        }
        return {
          ...milestone,
          status: "submitted",
          submittedBy: envelope.actorDid,
          evidenceBundleIds: [...new Set([...(payload.evidenceBundleIds ?? []), ...milestone.evidenceBundleIds])].sort(),
          oracleAttestationIds: [...new Set([...(payload.oracleAttestationIds ?? []), ...milestone.oracleAttestationIds])].sort()
        };
      });
      return {
        ...currentState,
        milestones,
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    case "contract.milestone-accepted": {
      const payload = envelope.payload as {
        milestoneId: string;
        evidenceBundleIds?: string[];
        oracleAttestationIds?: string[];
      };
      const milestones = updateMilestone(currentState, payload.milestoneId, (milestone) => {
        if (milestone.status !== "submitted" && milestone.status !== "open") {
          throw new ProtocolConflictError("Only submitted or open milestones can be accepted");
        }
        const nextMilestone: ContractMilestoneState = {
          ...milestone,
          status: "accepted",
          acceptedBy: envelope.actorDid,
          evidenceBundleIds: [...new Set([...(payload.evidenceBundleIds ?? []), ...milestone.evidenceBundleIds])].sort(),
          oracleAttestationIds: [...new Set([...(payload.oracleAttestationIds ?? []), ...milestone.oracleAttestationIds])].sort()
        };
        if (!milestoneHasProof(nextMilestone)) {
          throw new ProtocolConflictError("Accepted milestones must reference evidence, oracle attestations, or explicit counterparty acceptance mode");
        }
        return nextMilestone;
      });
      return {
        ...currentState,
        milestones,
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    case "contract.milestone-rejected": {
      const payload = envelope.payload as { milestoneId: string; reason: string };
      assertNonEmpty(payload.reason, "contract.milestone-rejected.reason");
      const milestones = updateMilestone(currentState, payload.milestoneId, (milestone) => {
        if (milestone.status !== "submitted" && milestone.status !== "open") {
          throw new ProtocolConflictError("Only submitted or open milestones can be rejected");
        }
        return {
          ...milestone,
          status: "rejected",
          rejectedBy: envelope.actorDid,
          rejectionReason: payload.reason
        };
      });
      return {
        ...currentState,
        milestones,
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    case "contract.paused":
      if (currentState.status !== "active") {
        throw new ProtocolConflictError("Only active contracts can be paused");
      }
      return {
        ...currentState,
        status: "paused",
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    case "contract.resumed":
      if (currentState.status !== "paused") {
        throw new ProtocolConflictError("Only paused contracts can be resumed");
      }
      return {
        ...currentState,
        status: "active",
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    case "contract.completed":
      if (currentState.status !== "active") {
        throw new ProtocolConflictError("Only active contracts can be completed");
      }
      if (Object.values(currentState.milestones).some((milestone) => milestone.status !== "accepted" || !milestoneHasProof(milestone))) {
        throw new ProtocolConflictError("Contracts can only complete once every milestone is accepted with proof");
      }
      return {
        ...currentState,
        status: "completed",
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    case "contract.canceled":
      if (currentState.status === "completed") {
        throw new ProtocolConflictError("Completed contracts cannot be canceled");
      }
      return {
        ...currentState,
        status: "canceled",
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    case "contract.disputed":
      if (currentState.status === "completed" || currentState.status === "canceled") {
        throw new ProtocolConflictError("Completed or canceled contracts cannot be disputed");
      }
      return {
        ...currentState,
        status: "disputed",
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    case "contract.created":
      throw new ProtocolConflictError("contract.created cannot be appended twice");
    default:
      throw new ProtocolValidationError(`Unsupported contract event: ${envelope.eventKind}`);
  }
}

export function contractCreatedPayloadToJson(payload: ContractCreatedPayload): ProtocolJsonObject {
  return payload as unknown as ProtocolJsonObject;
}
