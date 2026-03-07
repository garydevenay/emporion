import { ProtocolConflictError, ProtocolValidationError } from "../errors.js";
import type { ProtocolEnvelope } from "./envelope.js";
import type { ContractState, ProofMode, ResolutionMode } from "./contracts.js";
import { assertIsoTimestamp, type ProtocolJsonObject } from "./shared.js";

export interface EvidenceBundleState {
  objectId: string;
  contractId: string;
  milestoneId: string;
  submitterDid: string;
  artifactRefs: {
    artifactId: string;
    hash: string;
    mediaType?: string;
    uri?: string;
  }[];
  verifierRefs: {
    verifierId: string;
    verifierKind: "deterministic" | "oracle-service" | "human-review";
    verifierDid?: string;
    algorithm?: string;
    endpointUri?: string;
  }[];
  proofModes: ProofMode[];
  reproInstructions?: string;
  hashes: Record<string, string>;
  executionTranscriptRefs: string[];
  status: "recorded" | "superseded";
  latestEventId: string;
  eventIds: string[];
}

export interface SubjectRef {
  objectKind: "contract" | "evidence-bundle" | "dispute-case";
  objectId: string;
  milestoneId?: string;
}

export interface OracleAttestationState {
  objectId: string;
  oracleDid: string;
  claimType: string;
  subjectRef: SubjectRef;
  outcome: "satisfied" | "unsatisfied" | "accepted" | "rejected" | "completed" | "breached";
  evidenceRefs: string[];
  issuedAt: string;
  expiresAt: string;
  status: "active" | "revoked";
  latestEventId: string;
  eventIds: string[];
}

export interface DisputeRuling {
  outcome: "fulfilled" | "breach" | "refund" | "partial" | "rejected-claim";
  resolutionMode: ResolutionMode;
  deterministicVerifierId?: string;
  oracleAttestationIds: string[];
  evidenceBundleIds: string[];
  approverDids: string[];
  summary?: string;
}

export interface DisputeCaseState {
  objectId: string;
  disputeId: string;
  contractId: string;
  milestoneId?: string;
  openedByDid: string;
  reason: string;
  evidenceBundleIds: string[];
  oracleAttestationIds: string[];
  status: "open" | "awaiting-oracle" | "ruled" | "closed";
  ruling?: DisputeRuling;
  latestEventId: string;
  eventIds: string[];
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new ProtocolValidationError(`${fieldName} must not be blank`);
  }
}

function assertHexHash(value: string, fieldName: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new ProtocolValidationError(`${fieldName} must be a 32-byte hex hash`);
  }
}

function ensureLatestPredecessor(
  state: { latestEventId: string } | undefined,
  envelope: ProtocolEnvelope,
  createEventKind: string
): void {
  if (!state) {
    if (envelope.eventKind !== createEventKind) {
      throw new ProtocolConflictError(`The first event must be ${createEventKind}`);
    }
    if (envelope.previousEventIds.length !== 0) {
      throw new ProtocolConflictError(`${createEventKind} must not reference previous events`);
    }
    return;
  }
  if (envelope.previousEventIds.length === 0 || !envelope.previousEventIds.includes(state.latestEventId)) {
    throw new ProtocolConflictError("Event must reference the latest event");
  }
}

export function applyEvidenceBundleEvent(
  currentState: EvidenceBundleState | undefined,
  envelope: ProtocolEnvelope,
  refs: {
    contracts: Map<string, ContractState>;
  }
): EvidenceBundleState {
  if (envelope.objectKind !== "evidence-bundle") {
    throw new ProtocolValidationError("Envelope is not an evidence-bundle event");
  }

  ensureLatestPredecessor(currentState, envelope, "evidence-bundle.recorded");
  switch (envelope.eventKind) {
    case "evidence-bundle.recorded": {
      const payload = envelope.payload as {
        contractId: string;
        milestoneId: string;
        submitterDid: string;
        artifactRefs: EvidenceBundleState["artifactRefs"];
        verifierRefs: EvidenceBundleState["verifierRefs"];
        proofModes: ProofMode[];
        reproInstructions?: string;
        hashes: Record<string, string>;
        executionTranscriptRefs?: string[];
      };
      const contract = refs.contracts.get(payload.contractId);
      if (!contract) {
        throw new ProtocolConflictError("Evidence bundle contract does not exist");
      }
      if (!contract.milestones[payload.milestoneId]) {
        throw new ProtocolConflictError("Evidence bundle milestone does not exist on the contract");
      }
      if (payload.submitterDid !== envelope.actorDid) {
        throw new ProtocolConflictError("Evidence bundle submitterDid must match the actor DID");
      }
      if (payload.artifactRefs.length === 0 && Object.keys(payload.hashes).length === 0) {
        throw new ProtocolValidationError("Evidence bundle must include artifactRefs or hashes");
      }
      for (const artifactRef of payload.artifactRefs) {
        assertNonEmpty(artifactRef.artifactId, "EvidenceBundle.artifactId");
        assertHexHash(artifactRef.hash, "EvidenceBundle.artifactHash");
      }
      for (const [key, hash] of Object.entries(payload.hashes)) {
        assertNonEmpty(key, "EvidenceBundle.hash key");
        assertHexHash(hash, `EvidenceBundle.hashes.${key}`);
      }
      return {
        objectId: envelope.objectId,
        contractId: payload.contractId,
        milestoneId: payload.milestoneId,
        submitterDid: payload.submitterDid,
        artifactRefs: payload.artifactRefs,
        verifierRefs: payload.verifierRefs,
        proofModes: [...new Set(payload.proofModes)].sort() as ProofMode[],
        ...(payload.reproInstructions ? { reproInstructions: payload.reproInstructions } : {}),
        hashes: payload.hashes,
        executionTranscriptRefs: [...new Set(payload.executionTranscriptRefs ?? [])].sort(),
        status: "recorded",
        latestEventId: envelope.eventId,
        eventIds: [envelope.eventId]
      };
    }
    case "evidence-bundle.superseded":
      if (!currentState) {
        throw new ProtocolConflictError("Cannot supersede an evidence bundle before it is recorded");
      }
      return {
        ...currentState,
        status: "superseded",
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    default:
      throw new ProtocolValidationError(`Unsupported evidence-bundle event: ${envelope.eventKind}`);
  }
}

export function applyOracleAttestationEvent(
  currentState: OracleAttestationState | undefined,
  envelope: ProtocolEnvelope,
  refs: {
    contracts: Map<string, ContractState>;
    evidenceBundles: Map<string, EvidenceBundleState>;
    disputes: Map<string, DisputeCaseState>;
  }
): OracleAttestationState {
  if (envelope.objectKind !== "oracle-attestation") {
    throw new ProtocolValidationError("Envelope is not an oracle-attestation event");
  }

  ensureLatestPredecessor(currentState, envelope, "oracle-attestation.recorded");
  switch (envelope.eventKind) {
    case "oracle-attestation.recorded": {
      const payload = envelope.payload as unknown as {
        oracleDid: string;
        claimType: string;
        subjectRef: SubjectRef;
        outcome: OracleAttestationState["outcome"];
        evidenceRefs: string[];
        issuedAt: string;
        expiresAt: string;
      };
      if (payload.oracleDid !== envelope.actorDid) {
        throw new ProtocolConflictError("Oracle attestation oracleDid must match the actor DID");
      }
      assertNonEmpty(payload.claimType, "OracleAttestation.claimType");
      assertIsoTimestamp(payload.issuedAt, "OracleAttestation.issuedAt");
      assertIsoTimestamp(payload.expiresAt, "OracleAttestation.expiresAt");
      if (Date.parse(payload.expiresAt) <= Date.parse(payload.issuedAt)) {
        throw new ProtocolValidationError("Oracle attestation expiresAt must be after issuedAt");
      }
      if (payload.subjectRef.objectKind === "contract" && !refs.contracts.get(payload.subjectRef.objectId)) {
        throw new ProtocolConflictError("Oracle attestation contract subject does not exist");
      }
      if (payload.subjectRef.objectKind === "evidence-bundle" && !refs.evidenceBundles.get(payload.subjectRef.objectId)) {
        throw new ProtocolConflictError("Oracle attestation evidence-bundle subject does not exist");
      }
      if (payload.subjectRef.objectKind === "dispute-case" && !refs.disputes.get(payload.subjectRef.objectId)) {
        throw new ProtocolConflictError("Oracle attestation dispute-case subject does not exist");
      }
      return {
        objectId: envelope.objectId,
        oracleDid: payload.oracleDid,
        claimType: payload.claimType,
        subjectRef: payload.subjectRef,
        outcome: payload.outcome,
        evidenceRefs: [...new Set(payload.evidenceRefs)].sort(),
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt,
        status: "active",
        latestEventId: envelope.eventId,
        eventIds: [envelope.eventId]
      };
    }
    case "oracle-attestation.revoked":
      if (!currentState) {
        throw new ProtocolConflictError("Cannot revoke an oracle attestation before it is recorded");
      }
      return {
        ...currentState,
        status: "revoked",
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    default:
      throw new ProtocolValidationError(`Unsupported oracle-attestation event: ${envelope.eventKind}`);
  }
}

function validateRuling(
  ruling: DisputeRuling,
  contract: ContractState,
  refs: {
    evidenceBundles: Map<string, EvidenceBundleState>;
    oracleAttestations: Map<string, OracleAttestationState>;
  }
): void {
  for (const evidenceBundleId of ruling.evidenceBundleIds) {
    const evidence = refs.evidenceBundles.get(evidenceBundleId);
    if (!evidence || evidence.contractId !== contract.contractId) {
      throw new ProtocolConflictError(`Dispute ruling evidence bundle ${evidenceBundleId} does not belong to the contract`);
    }
  }
  for (const oracleAttestationId of ruling.oracleAttestationIds) {
    const attestation = refs.oracleAttestations.get(oracleAttestationId);
    if (!attestation) {
      throw new ProtocolConflictError(`Dispute ruling oracle attestation ${oracleAttestationId} does not exist`);
    }
    if (attestation.status !== "active") {
      throw new ProtocolConflictError(`Dispute ruling oracle attestation ${oracleAttestationId} is not active`);
    }
    if (
      contract.resolutionPolicy.oracleQuorum &&
      !contract.resolutionPolicy.oracleQuorum.oracleDids.includes(attestation.oracleDid)
    ) {
      throw new ProtocolConflictError(`Oracle ${attestation.oracleDid} is not authorized by the contract resolution policy`);
    }
  }

  switch (contract.resolutionPolicy.mode) {
    case "deterministic":
      if (!ruling.deterministicVerifierId) {
        throw new ProtocolConflictError("Deterministic resolution requires a deterministicVerifierId");
      }
      if (!contract.resolutionPolicy.deterministicVerifierIds.includes(ruling.deterministicVerifierId)) {
        throw new ProtocolConflictError("Deterministic verifier is not authorized by the contract");
      }
      break;
    case "oracle":
      if (ruling.oracleAttestationIds.length === 0) {
        throw new ProtocolConflictError("Oracle resolution requires at least one oracle attestation");
      }
      if (
        contract.resolutionPolicy.oracleQuorum &&
        ruling.oracleAttestationIds.length < contract.resolutionPolicy.oracleQuorum.quorum
      ) {
        throw new ProtocolConflictError("Oracle resolution quorum was not met");
      }
      break;
    case "hybrid":
      if (!ruling.deterministicVerifierId && ruling.oracleAttestationIds.length === 0) {
        throw new ProtocolConflictError("Hybrid resolution requires a deterministic verifier or oracle attestation");
      }
      break;
    case "mutual":
      if (ruling.approverDids.length !== contract.parties.length) {
        throw new ProtocolConflictError("Mutual resolution requires every contract party in approverDids");
      }
      for (const party of contract.parties) {
        if (!ruling.approverDids.includes(party)) {
          throw new ProtocolConflictError(`Mutual resolution is missing party approval from ${party}`);
        }
      }
      break;
  }
}

export function applyDisputeCaseEvent(
  currentState: DisputeCaseState | undefined,
  envelope: ProtocolEnvelope,
  refs: {
    contracts: Map<string, ContractState>;
    evidenceBundles: Map<string, EvidenceBundleState>;
    oracleAttestations: Map<string, OracleAttestationState>;
  }
): DisputeCaseState {
  if (envelope.objectKind !== "dispute-case") {
    throw new ProtocolValidationError("Envelope is not a dispute-case event");
  }

  ensureLatestPredecessor(currentState, envelope, "dispute.opened");
  switch (envelope.eventKind) {
    case "dispute.opened": {
      const payload = envelope.payload as { contractId: string; milestoneId?: string; reason: string };
      const contract = refs.contracts.get(payload.contractId);
      if (!contract) {
        throw new ProtocolConflictError("Dispute contract does not exist");
      }
      if (!contract.parties.includes(envelope.actorDid)) {
        throw new ProtocolConflictError("Only contract parties can open a dispute");
      }
      if (payload.milestoneId && !contract.milestones[payload.milestoneId]) {
        throw new ProtocolConflictError("Dispute milestone does not exist on the contract");
      }
      assertNonEmpty(payload.reason, "DisputeCase.reason");
      return {
        objectId: envelope.objectId,
        disputeId: envelope.objectId,
        contractId: payload.contractId,
        ...(payload.milestoneId ? { milestoneId: payload.milestoneId } : {}),
        openedByDid: envelope.actorDid,
        reason: payload.reason,
        evidenceBundleIds: [],
        oracleAttestationIds: [],
        status: "open",
        latestEventId: envelope.eventId,
        eventIds: [envelope.eventId]
      };
    }
    case "dispute.evidence-added": {
      if (!currentState) {
        throw new ProtocolConflictError("Cannot add dispute evidence before the dispute is opened");
      }
      const payload = envelope.payload as { evidenceBundleIds: string[] };
      for (const evidenceBundleId of payload.evidenceBundleIds) {
        const evidence = refs.evidenceBundles.get(evidenceBundleId);
        if (!evidence || evidence.contractId !== currentState.contractId) {
          throw new ProtocolConflictError(`Dispute evidence bundle ${evidenceBundleId} does not belong to the dispute contract`);
        }
        if (currentState.milestoneId && evidence.milestoneId !== currentState.milestoneId) {
          throw new ProtocolConflictError(`Dispute evidence bundle ${evidenceBundleId} does not belong to the disputed milestone`);
        }
      }
      return {
        ...currentState,
        evidenceBundleIds: [...new Set([...currentState.evidenceBundleIds, ...payload.evidenceBundleIds])].sort(),
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    case "dispute.oracle-requested":
      if (!currentState) {
        throw new ProtocolConflictError("Cannot request an oracle before the dispute is opened");
      }
      return {
        ...currentState,
        status: "awaiting-oracle",
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    case "dispute.ruled": {
      if (!currentState) {
        throw new ProtocolConflictError("Cannot rule on a dispute before it is opened");
      }
      const contract = refs.contracts.get(currentState.contractId);
      if (!contract) {
        throw new ProtocolConflictError("Dispute contract does not exist");
      }
      const ruling = envelope.payload as unknown as DisputeRuling;
      validateRuling(ruling, contract, refs);
      return {
        ...currentState,
        evidenceBundleIds: [...new Set([...currentState.evidenceBundleIds, ...ruling.evidenceBundleIds])].sort(),
        oracleAttestationIds: [...new Set([...currentState.oracleAttestationIds, ...ruling.oracleAttestationIds])].sort(),
        status: "ruled",
        ruling,
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    case "dispute.closed":
      if (!currentState) {
        throw new ProtocolConflictError("Cannot close a dispute before it is opened");
      }
      if (currentState.status !== "ruled") {
        throw new ProtocolConflictError("Only ruled disputes can be closed");
      }
      return {
        ...currentState,
        status: "closed",
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    default:
      throw new ProtocolValidationError(`Unsupported dispute-case event: ${envelope.eventKind}`);
  }
}

export function evidenceBundlePayloadToJson(payload: Omit<EvidenceBundleState, "objectId" | "status" | "latestEventId" | "eventIds">): ProtocolJsonObject {
  return payload as unknown as ProtocolJsonObject;
}

export function oracleAttestationPayloadToJson(
  payload: Omit<OracleAttestationState, "objectId" | "status" | "latestEventId" | "eventIds">
): ProtocolJsonObject {
  return payload as unknown as ProtocolJsonObject;
}

export function disputeRulingToJson(ruling: DisputeRuling): ProtocolJsonObject {
  return ruling as unknown as ProtocolJsonObject;
}
