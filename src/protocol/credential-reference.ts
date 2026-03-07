import { ProtocolConflictError, ProtocolValidationError } from "../errors.js";
import { assertIsoTimestamp, sha256Hex, type ProtocolJsonObject, type ProtocolValue } from "./shared.js";

export type BitcoinNetwork = "bitcoin" | "testnet" | "signet" | "regtest";
export type LightningReferenceType =
  | "bolt11"
  | "bolt12-offer"
  | "bolt12-invoice-request"
  | "custodial-payment-ref";

export interface PaymentEndpoint {
  id: string;
  network: BitcoinNetwork;
  custodial: boolean;
  accountId?: string;
  nodeUri?: string;
  bolt12Offer?: string;
  capabilities: string[];
}

export interface CustodialWalletAttestationRef {
  attestationId: string;
  issuerDid: string;
  subjectDid: string;
  walletAccountId: string;
  network: BitcoinNetwork;
  currency: "BTC" | "SAT";
  attestedBalanceSats: number;
  attestedCapacitySats?: number;
  attestedAt: string;
  expiresAt: string;
  artifactHash: string;
  artifactUri?: string;
}

export interface FeedbackCredentialRef {
  credentialId: string;
  issuerDid: string;
  subjectDid: string;
  relatedContractId: string;
  relatedAgreementId: string;
  completionArtifactRef?: string;
  rulingRef?: string;
  summary: {
    score: number;
    maxScore: number;
    headline?: string;
    comment?: string;
  };
  issuedAt: string;
  expiresAt?: string;
  artifactHash: string;
  artifactUri?: string;
  revocationRef?: string;
}

export interface FeedbackCredentialRefState {
  objectId: string;
  credential: FeedbackCredentialRef;
  status: "active" | "revoked";
  latestEventId: string;
  eventIds: string[];
}

function assertHexHash(value: string, fieldName: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new ProtocolValidationError(`${fieldName} must be a 32-byte hex hash`);
  }
}

function assertNonEmptyString(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new ProtocolValidationError(`${fieldName} must not be blank`);
  }
}

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ProtocolValidationError(`${fieldName} must be a non-negative integer`);
  }
}

export function validatePaymentEndpoint(endpoint: PaymentEndpoint): void {
  assertNonEmptyString(endpoint.id, "PaymentEndpoint.id");
  assertNonEmptyString(endpoint.network, "PaymentEndpoint.network");
  if (endpoint.capabilities.length === 0) {
    throw new ProtocolValidationError("PaymentEndpoint.capabilities must contain at least one capability");
  }
}

export function validateCustodialWalletAttestationRef(attestation: CustodialWalletAttestationRef): void {
  assertNonEmptyString(attestation.attestationId, "CustodialWalletAttestationRef.attestationId");
  assertNonEmptyString(attestation.issuerDid, "CustodialWalletAttestationRef.issuerDid");
  assertNonEmptyString(attestation.subjectDid, "CustodialWalletAttestationRef.subjectDid");
  assertNonEmptyString(attestation.walletAccountId, "CustodialWalletAttestationRef.walletAccountId");
  assertPositiveInteger(attestation.attestedBalanceSats, "CustodialWalletAttestationRef.attestedBalanceSats");
  if (attestation.attestedCapacitySats !== undefined) {
    assertPositiveInteger(attestation.attestedCapacitySats, "CustodialWalletAttestationRef.attestedCapacitySats");
  }
  assertIsoTimestamp(attestation.attestedAt, "CustodialWalletAttestationRef.attestedAt");
  assertIsoTimestamp(attestation.expiresAt, "CustodialWalletAttestationRef.expiresAt");
  if (Date.parse(attestation.expiresAt) <= Date.parse(attestation.attestedAt)) {
    throw new ProtocolValidationError("CustodialWalletAttestationRef.expiresAt must be after attestedAt");
  }
  assertHexHash(attestation.artifactHash, "CustodialWalletAttestationRef.artifactHash");
}

export function validateFeedbackCredentialRef(credential: FeedbackCredentialRef): void {
  assertNonEmptyString(credential.credentialId, "FeedbackCredentialRef.credentialId");
  assertNonEmptyString(credential.issuerDid, "FeedbackCredentialRef.issuerDid");
  assertNonEmptyString(credential.subjectDid, "FeedbackCredentialRef.subjectDid");
  assertNonEmptyString(credential.relatedContractId, "FeedbackCredentialRef.relatedContractId");
  assertNonEmptyString(credential.relatedAgreementId, "FeedbackCredentialRef.relatedAgreementId");
  if (!Number.isFinite(credential.summary.score) || credential.summary.score < 0) {
    throw new ProtocolValidationError("FeedbackCredentialRef.summary.score must be >= 0");
  }
  if (!Number.isFinite(credential.summary.maxScore) || credential.summary.maxScore <= 0) {
    throw new ProtocolValidationError("FeedbackCredentialRef.summary.maxScore must be > 0");
  }
  if (credential.summary.score > credential.summary.maxScore) {
    throw new ProtocolValidationError("FeedbackCredentialRef.summary.score must be <= maxScore");
  }
  assertIsoTimestamp(credential.issuedAt, "FeedbackCredentialRef.issuedAt");
  if (credential.expiresAt !== undefined) {
    assertIsoTimestamp(credential.expiresAt, "FeedbackCredentialRef.expiresAt");
    if (Date.parse(credential.expiresAt) <= Date.parse(credential.issuedAt)) {
      throw new ProtocolValidationError("FeedbackCredentialRef.expiresAt must be after issuedAt");
    }
  }
  assertHexHash(credential.artifactHash, "FeedbackCredentialRef.artifactHash");
}

export function paymentEndpointToJson(endpoint: PaymentEndpoint): ProtocolJsonObject {
  return endpoint as unknown as ProtocolJsonObject;
}

export function custodialWalletAttestationToJson(attestation: CustodialWalletAttestationRef): ProtocolJsonObject {
  return attestation as unknown as ProtocolJsonObject;
}

export function feedbackCredentialRefToJson(credential: FeedbackCredentialRef): ProtocolJsonObject {
  return credential as unknown as ProtocolJsonObject;
}

export function isProtocolJsonObject(value: ProtocolValue): value is ProtocolJsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function createCredentialArtifactHash(artifact: ProtocolValue | string | Buffer): string {
  return sha256Hex(artifact);
}

export function assertWalletAttestationArtifactMatches(
  attestation: CustodialWalletAttestationRef,
  artifact: ProtocolValue | string | Buffer
): void {
  if (createCredentialArtifactHash(artifact) !== attestation.artifactHash) {
    throw new ProtocolConflictError("Custodial wallet attestation artifact hash mismatch");
  }
}

export function assertFeedbackCredentialArtifactMatches(
  credential: FeedbackCredentialRef,
  artifact: ProtocolValue | string | Buffer
): void {
  if (createCredentialArtifactHash(artifact) !== credential.artifactHash) {
    throw new ProtocolConflictError("Feedback credential artifact hash mismatch");
  }
}

export function applyFeedbackCredentialRefEvent(
  currentState: FeedbackCredentialRefState | undefined,
  envelope: {
    objectKind: string;
    objectId: string;
    eventKind: string;
    eventId: string;
    previousEventIds: string[];
    payload: ProtocolJsonObject;
  }
): FeedbackCredentialRefState {
  if (envelope.objectKind !== "feedback-credential-ref") {
    throw new ProtocolValidationError("Envelope is not a feedback-credential-ref event");
  }

  switch (envelope.eventKind) {
    case "feedback-credential-ref.recorded": {
      if (currentState) {
        throw new ProtocolConflictError("feedback-credential-ref.recorded cannot be appended twice");
      }
      if (envelope.previousEventIds.length !== 0) {
        throw new ProtocolConflictError("feedback-credential-ref.recorded must not reference previous events");
      }
      const credential = envelope.payload as unknown as FeedbackCredentialRef;
      validateFeedbackCredentialRef(credential);
      if (credential.credentialId !== envelope.objectId) {
        throw new ProtocolConflictError("Feedback credential objectId must equal credentialId");
      }
      return {
        objectId: envelope.objectId,
        credential,
        status: "active",
        latestEventId: envelope.eventId,
        eventIds: [envelope.eventId]
      };
    }
    case "feedback-credential-ref.revoked": {
      if (!currentState) {
        throw new ProtocolConflictError("Cannot revoke a feedback credential ref before it is recorded");
      }
      if (envelope.previousEventIds.length === 0 || !envelope.previousEventIds.includes(currentState.latestEventId)) {
        throw new ProtocolConflictError("Feedback credential revoke must reference the latest event");
      }
      if (currentState.status === "revoked") {
        throw new ProtocolConflictError("Feedback credential ref is already revoked");
      }
      return {
        ...currentState,
        status: "revoked",
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    default:
      throw new ProtocolValidationError(`Unsupported feedback-credential-ref event: ${envelope.eventKind}`);
  }
}
