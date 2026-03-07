import type { ProtocolEnvelope } from "./envelope.js";
import type { ContractState } from "./contracts.js";
import type { CompanyState } from "./company.js";
import type { AgentProfileState } from "./identity.js";
import type { AgreementState, BidState, ListingState, OfferState, ProductState, RequestState } from "./market.js";
import type { DisputeCaseState, EvidenceBundleState, OracleAttestationState } from "./resolution.js";
import type { FeedbackCredentialRefState } from "./credential-reference.js";
import type { MessageState, SpaceMembershipState, SpaceState } from "./messaging.js";
import type { ProtocolJsonObject } from "./shared.js";
import type { ProtocolFamily, ProtocolObjectKind, ProtocolVersionString } from "./versioning.js";

export type DisseminationState =
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

export interface ProtocolObjectHeadAnnouncement {
  kind: "protocol-object-head";
  protocol?: ProtocolFamily | "emporion.protocol";
  version?: ProtocolVersionString | 1;
  objectKind: ProtocolObjectKind;
  objectId: string;
  headEventId: string;
  actorDid: string;
  subjectId: string;
  updatedAt: string;
  marketplaceId?: string;
  companyDid?: string;
  contractId?: string;
  spaceId?: string;
  status?: string;
}

export interface SpaceDescriptorAnnouncement {
  kind: "space-descriptor";
  protocol?: ProtocolFamily | "emporion.protocol";
  version?: ProtocolVersionString | 1;
  objectKind: "space";
  objectId: string;
  headEventId: string;
  actorDid: string;
  subjectId: string;
  updatedAt: string;
  spaceKind: SpaceState["spaceKind"];
  ownerRef: SpaceState["ownerRef"];
  encryptionMode: SpaceState["encryptionPolicy"]["mode"];
  membershipMode: SpaceState["membershipPolicy"]["mode"];
  status: SpaceState["status"];
}

export type ProtocolAnnouncement = ProtocolObjectHeadAnnouncement | SpaceDescriptorAnnouncement;

function stateStatus(state: DisseminationState): string | undefined {
  return "status" in state ? String(state.status) : undefined;
}

function currentMarketplaceId(state: DisseminationState): string | undefined {
  return "marketplaceId" in state ? state.marketplaceId : undefined;
}

function currentCompanyDid(state: DisseminationState): string | undefined {
  if ("companyDid" in state && typeof state.companyDid === "string") {
    return state.companyDid;
  }
  if ("ownerDid" in state && String(state.ownerDid).startsWith("did:emporion:company:")) {
    return state.ownerDid;
  }
  if ("sellerDid" in state && String(state.sellerDid).startsWith("did:emporion:company:")) {
    return state.sellerDid;
  }
  if ("requesterDid" in state && String(state.requesterDid).startsWith("did:emporion:company:")) {
    return state.requesterDid;
  }
  if ("proposerDid" in state && String(state.proposerDid).startsWith("did:emporion:company:")) {
    return state.proposerDid;
  }
  return undefined;
}

function currentContractId(state: DisseminationState): string | undefined {
  if ("contractId" in state && typeof state.contractId === "string") {
    return state.contractId;
  }
  if ("subjectRef" in state && state.subjectRef && typeof state.subjectRef === "object" && state.subjectRef.objectKind === "contract") {
    return state.subjectRef.objectId;
  }
  return undefined;
}

function currentSpaceId(state: DisseminationState): string | undefined {
  if ("spaceId" in state && typeof state.spaceId === "string") {
    return state.spaceId;
  }
  return undefined;
}

export function createProtocolAnnouncement(
  envelope: ProtocolEnvelope,
  state: DisseminationState
): ProtocolAnnouncement {
  if (envelope.objectKind === "space") {
    const spaceState = state as SpaceState;
    return {
      kind: "space-descriptor",
      protocol: envelope.protocol,
      version: envelope.version,
      objectKind: "space",
      objectId: envelope.objectId,
      headEventId: envelope.eventId,
      actorDid: envelope.actorDid,
      subjectId: envelope.subjectId,
      updatedAt: envelope.issuedAt,
      spaceKind: spaceState.spaceKind,
      ownerRef: spaceState.ownerRef,
      encryptionMode: spaceState.encryptionPolicy.mode,
      membershipMode: spaceState.membershipPolicy.mode,
      status: spaceState.status
    };
  }

  const announcement: ProtocolObjectHeadAnnouncement = {
    kind: "protocol-object-head",
    protocol: envelope.protocol,
    version: envelope.version,
    objectKind: envelope.objectKind,
    objectId: envelope.objectId,
    headEventId: envelope.eventId,
    actorDid: envelope.actorDid,
    subjectId: envelope.subjectId,
    updatedAt: envelope.issuedAt
  };
  const marketplaceId = currentMarketplaceId(state);
  const companyDid = currentCompanyDid(state);
  const contractId = currentContractId(state);
  const spaceId = currentSpaceId(state);
  const status = stateStatus(state);
  if (marketplaceId) {
    announcement.marketplaceId = marketplaceId;
  }
  if (companyDid) {
    announcement.companyDid = companyDid;
  }
  if (contractId) {
    announcement.contractId = contractId;
  }
  if (spaceId) {
    announcement.spaceId = spaceId;
  }
  if (status) {
    announcement.status = status;
  }
  return announcement;
}

export function isProtocolAnnouncement(value: unknown): value is ProtocolAnnouncement {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ProtocolAnnouncement>;
  return (
    (candidate.kind === "protocol-object-head" || candidate.kind === "space-descriptor") &&
    (candidate.protocol === undefined || typeof candidate.protocol === "string") &&
    (candidate.version === undefined || typeof candidate.version === "string" || typeof candidate.version === "number") &&
    typeof candidate.objectKind === "string" &&
    typeof candidate.objectId === "string" &&
    typeof candidate.headEventId === "string" &&
    typeof candidate.actorDid === "string" &&
    typeof candidate.subjectId === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

export function protocolAnnouncementToJson(announcement: ProtocolAnnouncement): ProtocolJsonObject {
  return announcement as unknown as ProtocolJsonObject;
}
