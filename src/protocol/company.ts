import { ProtocolConflictError, ProtocolValidationError } from "../errors.js";
import type { CustodialWalletAttestationRef } from "./credential-reference.js";
import { validateCustodialWalletAttestationRef } from "./credential-reference.js";
import type { ProtocolEnvelope } from "./envelope.js";
import { sha256Hex } from "./shared.js";

export type CompanyRole = "owner" | "operator" | "member";

export type CompanyEventKind =
  | "company.genesis"
  | "company.profile-updated"
  | "company.role-granted"
  | "company.role-revoked"
  | "company.treasury-attested"
  | "company.treasury-reserved"
  | "company.treasury-released"
  | "company.market-joined"
  | "company.market-left";

export interface CompanyGenesisPayload {
  name: string;
  description?: string;
  initialOwners: string[];
}

export interface CompanyRoleChangePayload {
  memberDid: string;
  role: CompanyRole;
}

export interface CompanyTreasuryReservation {
  reservationId: string;
  amountSats: number;
  reason: string;
  createdAt: string;
}

export interface CompanyState {
  companyDid: string;
  name: string;
  description: string | undefined;
  roles: Record<CompanyRole, string[]>;
  treasuryAttestations: Record<string, CustodialWalletAttestationRef>;
  treasuryReservations: Record<string, CompanyTreasuryReservation>;
  joinedMarketplaces: string[];
  latestEventId: string;
  eventIds: string[];
}

function sortUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

export function deriveCompanyDidFromGenesis(input: {
  actorDid: string;
  issuedAt: string;
  payload: CompanyGenesisPayload;
}): string {
  const payloadSeed: Record<string, string | string[]> = {
    name: input.payload.name,
    initialOwners: [...input.payload.initialOwners]
  };
  if (input.payload.description !== undefined) {
    payloadSeed.description = input.payload.description;
  }

  const genesisHash = sha256Hex({
    actorDid: input.actorDid,
    issuedAt: input.issuedAt,
    payload: payloadSeed
  });
  return `did:emporion:company:${genesisHash}`;
}

function hasRole(state: CompanyState | undefined, did: string, role: CompanyRole): boolean {
  return !!state && state.roles[role].includes(did);
}

function assertOperationalActor(state: CompanyState | undefined, actorDid: string): void {
  if (!hasRole(state, actorDid, "owner") && !hasRole(state, actorDid, "operator")) {
    throw new ProtocolConflictError("Company event requires owner or operator role");
  }
}

function ensureLatestPredecessor(state: CompanyState | undefined, envelope: ProtocolEnvelope): void {
  if (!state) {
    if (envelope.previousEventIds.length !== 0) {
      throw new ProtocolConflictError("Genesis company event must not reference previous events");
    }
    return;
  }

  if (envelope.previousEventIds.length === 0 || !envelope.previousEventIds.includes(state.latestEventId)) {
    throw new ProtocolConflictError("Company events must reference the latest event in previousEventIds");
  }
}

export function applyCompanyEvent(currentState: CompanyState | undefined, envelope: ProtocolEnvelope): CompanyState {
  if (envelope.objectKind !== "company") {
    throw new ProtocolValidationError("Envelope is not a company event");
  }

  const eventKind = envelope.eventKind as CompanyEventKind;
  ensureLatestPredecessor(currentState, envelope);

  if (!currentState) {
    if (eventKind !== "company.genesis") {
      throw new ProtocolConflictError("The first company event must be company.genesis");
    }
    const payload = envelope.payload as unknown as CompanyGenesisPayload;
    if (payload.initialOwners.length === 0) {
      throw new ProtocolValidationError("Company genesis must include at least one initial owner");
    }
    const derivedDid = deriveCompanyDidFromGenesis({
      actorDid: envelope.actorDid,
      issuedAt: envelope.issuedAt,
      payload
    });
    if (envelope.objectId !== derivedDid || envelope.subjectId !== derivedDid) {
      throw new ProtocolConflictError("Company genesis objectId and subjectId must equal the derived company DID");
    }
    if (!payload.initialOwners.includes(envelope.actorDid)) {
      throw new ProtocolConflictError("Company genesis actor must be included in initialOwners");
    }

    return {
      companyDid: derivedDid,
      name: payload.name,
      description: payload.description,
      roles: {
        owner: sortUnique(payload.initialOwners),
        operator: [],
        member: []
      },
      treasuryAttestations: {},
      treasuryReservations: {},
      joinedMarketplaces: [],
      latestEventId: envelope.eventId,
      eventIds: [envelope.eventId]
    };
  }

  if (envelope.objectId !== currentState.companyDid || envelope.subjectId !== currentState.companyDid) {
    throw new ProtocolConflictError("Company event objectId and subjectId must match the company DID");
  }

  switch (eventKind) {
    case "company.profile-updated": {
      assertOperationalActor(currentState, envelope.actorDid);
      const payload = envelope.payload as { name?: string; description?: string };
      return {
        ...currentState,
        name: payload.name ?? currentState.name,
        description: payload.description ?? currentState.description,
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    case "company.role-granted": {
      const payload = envelope.payload as unknown as CompanyRoleChangePayload;
      if (!hasRole(currentState, envelope.actorDid, "owner")) {
        throw new ProtocolConflictError("Only company owners can grant roles");
      }
      return {
        ...currentState,
        roles: {
          owner:
            payload.role === "owner"
              ? sortUnique([...currentState.roles.owner, payload.memberDid])
              : currentState.roles.owner,
          operator:
            payload.role === "operator"
              ? sortUnique([...currentState.roles.operator, payload.memberDid])
              : currentState.roles.operator,
          member:
            payload.role === "member"
              ? sortUnique([...currentState.roles.member, payload.memberDid])
              : currentState.roles.member
        },
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    case "company.role-revoked": {
      const payload = envelope.payload as unknown as CompanyRoleChangePayload;
      if (!hasRole(currentState, envelope.actorDid, "owner")) {
        throw new ProtocolConflictError("Only company owners can revoke roles");
      }
      const nextRoles = {
        owner: currentState.roles.owner.filter((entry) => !(payload.role === "owner" && entry === payload.memberDid)),
        operator: currentState.roles.operator.filter(
          (entry) => !(payload.role === "operator" && entry === payload.memberDid)
        ),
        member: currentState.roles.member.filter((entry) => !(payload.role === "member" && entry === payload.memberDid))
      };
      if (payload.role === "owner" && nextRoles.owner.length === 0) {
        throw new ProtocolConflictError("A company must retain at least one owner");
      }
      return {
        ...currentState,
        roles: nextRoles,
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    case "company.treasury-attested": {
      assertOperationalActor(currentState, envelope.actorDid);
      const attestation = envelope.payload as unknown as CustodialWalletAttestationRef;
      validateCustodialWalletAttestationRef(attestation);
      if (attestation.subjectDid !== currentState.companyDid) {
        throw new ProtocolConflictError("Treasury attestation subjectDid must match the company DID");
      }
      return {
        ...currentState,
        treasuryAttestations: {
          ...currentState.treasuryAttestations,
          [attestation.attestationId]: attestation
        },
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    case "company.treasury-reserved": {
      assertOperationalActor(currentState, envelope.actorDid);
      const payload = envelope.payload as unknown as CompanyTreasuryReservation;
      if (!Number.isInteger(payload.amountSats) || payload.amountSats <= 0) {
        throw new ProtocolValidationError("Treasury reservation amountSats must be a positive integer");
      }
      return {
        ...currentState,
        treasuryReservations: {
          ...currentState.treasuryReservations,
          [payload.reservationId]: payload
        },
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    case "company.treasury-released": {
      assertOperationalActor(currentState, envelope.actorDid);
      const reservationId = String((envelope.payload as Record<string, unknown>).reservationId ?? "");
      if (!currentState.treasuryReservations[reservationId]) {
        throw new ProtocolConflictError(`Unknown treasury reservation: ${reservationId}`);
      }
      const treasuryReservations = { ...currentState.treasuryReservations };
      delete treasuryReservations[reservationId];
      return {
        ...currentState,
        treasuryReservations,
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    case "company.market-joined": {
      assertOperationalActor(currentState, envelope.actorDid);
      const marketplaceId = String((envelope.payload as Record<string, unknown>).marketplaceId ?? "");
      return {
        ...currentState,
        joinedMarketplaces: sortUnique([...currentState.joinedMarketplaces, marketplaceId]),
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    case "company.market-left": {
      assertOperationalActor(currentState, envelope.actorDid);
      const marketplaceId = String((envelope.payload as Record<string, unknown>).marketplaceId ?? "");
      return {
        ...currentState,
        joinedMarketplaces: currentState.joinedMarketplaces.filter((entry) => entry !== marketplaceId),
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    case "company.genesis":
      throw new ProtocolConflictError("company.genesis cannot be appended after the company exists");
  }
}
