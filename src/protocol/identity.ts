import { ProtocolConflictError, ProtocolValidationError } from "../errors.js";
import type {
  CustodialWalletAttestationRef,
  FeedbackCredentialRef,
  PaymentEndpoint
} from "./credential-reference.js";
import {
  validateCustodialWalletAttestationRef,
  validateFeedbackCredentialRef,
  validatePaymentEndpoint
} from "./credential-reference.js";
import type { ProtocolEnvelope } from "./envelope.js";

export type AgentProfileEventKind =
  | "agent-profile.created"
  | "agent-profile.updated"
  | "agent-profile.payment-endpoint-added"
  | "agent-profile.payment-endpoint-removed"
  | "agent-profile.wallet-attestation-added"
  | "agent-profile.wallet-attestation-removed"
  | "agent-profile.feedback-credential-added"
  | "agent-profile.feedback-credential-removed";

export interface AgentProfilePayload {
  displayName?: string;
  bio?: string;
}

export interface AgentProfileState {
  did: string;
  displayName: string | undefined;
  bio: string | undefined;
  paymentEndpoints: Record<string, PaymentEndpoint>;
  custodialWalletAttestations: Record<string, CustodialWalletAttestationRef>;
  feedbackCredentialRefs: Record<string, FeedbackCredentialRef>;
  latestEventId: string;
  eventIds: string[];
}

function createEmptyAgentProfileState(did: string, eventId: string): AgentProfileState {
  return {
    did,
    displayName: undefined,
    bio: undefined,
    paymentEndpoints: {},
    custodialWalletAttestations: {},
    feedbackCredentialRefs: {},
    latestEventId: eventId,
    eventIds: []
  };
}

function assertAgentEnvelope(envelope: ProtocolEnvelope): void {
  if (envelope.objectKind !== "agent-profile") {
    throw new ProtocolValidationError("Envelope is not an agent-profile event");
  }
  if (envelope.objectId !== envelope.actorDid || envelope.subjectId !== envelope.actorDid) {
    throw new ProtocolValidationError("Agent-profile events must use the actor DID as objectId and subjectId");
  }
}

export function applyAgentProfileEvent(
  currentState: AgentProfileState | undefined,
  envelope: ProtocolEnvelope
): AgentProfileState {
  assertAgentEnvelope(envelope);
  const eventKind = envelope.eventKind as AgentProfileEventKind;

  if (!currentState) {
    if (eventKind !== "agent-profile.created") {
      throw new ProtocolConflictError("The first agent-profile event must be agent-profile.created");
    }
    if (envelope.previousEventIds.length !== 0) {
      throw new ProtocolConflictError("The first agent-profile event must not reference previous events");
    }
  } else {
    if (envelope.previousEventIds.length === 0 || !envelope.previousEventIds.includes(currentState.latestEventId)) {
      throw new ProtocolConflictError("Agent-profile events must reference the latest event in previousEventIds");
    }
  }

  switch (eventKind) {
    case "agent-profile.created":
    case "agent-profile.updated": {
      const payload = envelope.payload as AgentProfilePayload;
      return {
        did: envelope.actorDid,
        displayName: payload.displayName ?? currentState?.displayName,
        bio: payload.bio ?? currentState?.bio,
        paymentEndpoints: { ...(currentState?.paymentEndpoints ?? {}) },
        custodialWalletAttestations: { ...(currentState?.custodialWalletAttestations ?? {}) },
        feedbackCredentialRefs: { ...(currentState?.feedbackCredentialRefs ?? {}) },
        latestEventId: envelope.eventId,
        eventIds: [...(currentState?.eventIds ?? []), envelope.eventId]
      };
    }
    case "agent-profile.payment-endpoint-added": {
      const endpoint = envelope.payload as unknown as PaymentEndpoint;
      validatePaymentEndpoint(endpoint);
      return {
        ...(currentState ?? createEmptyAgentProfileState(envelope.actorDid, envelope.eventId)),
        paymentEndpoints: {
          ...(currentState?.paymentEndpoints ?? {}),
          [endpoint.id]: endpoint
        },
        latestEventId: envelope.eventId,
        eventIds: [...(currentState?.eventIds ?? []), envelope.eventId]
      };
    }
    case "agent-profile.payment-endpoint-removed": {
      const endpointId = String((envelope.payload as Record<string, unknown>).paymentEndpointId ?? "");
      if (!currentState?.paymentEndpoints[endpointId]) {
        throw new ProtocolConflictError(`Unknown payment endpoint: ${endpointId}`);
      }
      const paymentEndpoints = { ...currentState.paymentEndpoints };
      delete paymentEndpoints[endpointId];
      return {
        ...currentState,
        paymentEndpoints,
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    case "agent-profile.wallet-attestation-added": {
      const attestation = envelope.payload as unknown as CustodialWalletAttestationRef;
      validateCustodialWalletAttestationRef(attestation);
      if (attestation.subjectDid !== envelope.actorDid) {
        throw new ProtocolConflictError("Custodial wallet attestation subject must match the agent profile DID");
      }
      return {
        ...(currentState ?? createEmptyAgentProfileState(envelope.actorDid, envelope.eventId)),
        custodialWalletAttestations: {
          ...(currentState?.custodialWalletAttestations ?? {}),
          [attestation.attestationId]: attestation
        },
        latestEventId: envelope.eventId,
        eventIds: [...(currentState?.eventIds ?? []), envelope.eventId]
      };
    }
    case "agent-profile.wallet-attestation-removed": {
      const attestationId = String((envelope.payload as Record<string, unknown>).attestationId ?? "");
      if (!currentState?.custodialWalletAttestations[attestationId]) {
        throw new ProtocolConflictError(`Unknown wallet attestation: ${attestationId}`);
      }
      const custodialWalletAttestations = { ...currentState.custodialWalletAttestations };
      delete custodialWalletAttestations[attestationId];
      return {
        ...currentState,
        custodialWalletAttestations,
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    case "agent-profile.feedback-credential-added": {
      const credential = envelope.payload as unknown as FeedbackCredentialRef;
      validateFeedbackCredentialRef(credential);
      if (credential.subjectDid !== envelope.actorDid) {
        throw new ProtocolConflictError("Feedback credential subject must match the agent profile DID");
      }
      return {
        ...(currentState ?? createEmptyAgentProfileState(envelope.actorDid, envelope.eventId)),
        feedbackCredentialRefs: {
          ...(currentState?.feedbackCredentialRefs ?? {}),
          [credential.credentialId]: credential
        },
        latestEventId: envelope.eventId,
        eventIds: [...(currentState?.eventIds ?? []), envelope.eventId]
      };
    }
    case "agent-profile.feedback-credential-removed": {
      const credentialId = String((envelope.payload as Record<string, unknown>).credentialId ?? "");
      if (!currentState?.feedbackCredentialRefs[credentialId]) {
        throw new ProtocolConflictError(`Unknown feedback credential ref: ${credentialId}`);
      }
      const feedbackCredentialRefs = { ...currentState.feedbackCredentialRefs };
      delete feedbackCredentialRefs[credentialId];
      return {
        ...currentState,
        feedbackCredentialRefs,
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
  }
}
