import { randomBytes } from "node:crypto";

import bs58 from "bs58";
import nacl from "tweetnacl";

import { extractKeyAgreementPublicKeyMultibase, resolveDidDocument } from "../did.js";
import { ProtocolConflictError, ProtocolValidationError } from "../errors.js";
import type { ProtocolEnvelope } from "./envelope.js";
import {
  assertIsoTimestamp,
  decodeBase64Url,
  encodeBase64Url,
  type ProtocolJsonObject
} from "./shared.js";

const X25519_MULTICODEC_PREFIX = Buffer.from([0xec, 0x01]);

export type SpaceKind = "direct-inbox" | "contract-thread" | "company-room" | "market-room";

export interface MembershipPolicy {
  mode: "invite-only" | "owner-controlled" | "public-read";
  ownerMemberDids: string[];
}

export interface EncryptionPolicy {
  mode: "none" | "member-sealed-box";
  keyAgreementMethod: "did-keyagreement-v1";
}

export interface OwnerRef {
  kind: "agent" | "company" | "marketplace" | "contract" | "dispute";
  id: string;
}

export interface SpaceState {
  objectId: string;
  spaceId: string;
  spaceKind: SpaceKind;
  ownerRef: OwnerRef;
  membershipPolicy: MembershipPolicy;
  encryptionPolicy: EncryptionPolicy;
  status: "active" | "archived";
  latestEventId: string;
  eventIds: string[];
}

export interface SpaceMembershipState {
  objectId: string;
  spaceId: string;
  memberDid: string;
  role: "owner" | "moderator" | "member";
  status: "active" | "removed" | "muted";
  latestEventId: string;
  eventIds: string[];
}

export interface EncryptedRecipientBox {
  recipientDid: string;
  nonce: string;
  ciphertext: string;
}

export interface EncryptedMessageBody {
  senderDid: string;
  senderKeyAgreementPublicKey: string;
  recipientBoxes: EncryptedRecipientBox[];
}

export interface MessageState {
  objectId: string;
  spaceId: string;
  senderDid: string;
  messageType: string;
  metadata: ProtocolJsonObject;
  encryptedBody: EncryptedMessageBody;
  status: "sent" | "edited" | "deleted";
  reactions: Record<string, string[]>;
  latestEventId: string;
  eventIds: string[];
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new ProtocolValidationError(`${fieldName} must not be blank`);
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

function decodeX25519Multibase(publicKeyMultibase: string): Uint8Array {
  if (!publicKeyMultibase.startsWith("z")) {
    throw new ProtocolValidationError("Messaging keys must use base58-btc multibase");
  }
  const decoded = Buffer.from(bs58.decode(publicKeyMultibase.slice(1)));
  if (decoded.byteLength < 3 || decoded[0] !== X25519_MULTICODEC_PREFIX[0] || decoded[1] !== X25519_MULTICODEC_PREFIX[1]) {
    throw new ProtocolValidationError("Messaging key multibase is not an X25519 multicodec");
  }
  return decoded.subarray(2);
}

function activeMembersForSpace(spaceId: string, memberships: Map<string, SpaceMembershipState>): Map<string, SpaceMembershipState> {
  const results = new Map<string, SpaceMembershipState>();
  for (const membership of memberships.values()) {
    if (membership.spaceId === spaceId && membership.status !== "removed") {
      results.set(membership.memberDid, membership);
    }
  }
  return results;
}

function assertCanManageMembership(space: SpaceState, actorDid: string, memberships: Map<string, SpaceMembershipState>): void {
  if (space.membershipPolicy.ownerMemberDids.includes(actorDid)) {
    return;
  }
  const membership = activeMembersForSpace(space.spaceId, memberships).get(actorDid);
  if (membership?.role === "owner" || membership?.role === "moderator") {
    return;
  }
  throw new ProtocolConflictError("Only owners or moderators can manage space membership");
}

function assertActiveMember(spaceId: string, actorDid: string, memberships: Map<string, SpaceMembershipState>): SpaceMembershipState {
  const membership = activeMembersForSpace(spaceId, memberships).get(actorDid);
  if (!membership || membership.status !== "active") {
    throw new ProtocolConflictError("Actor must be an active member of the space");
  }
  return membership;
}

export async function encryptMessageForRecipients(input: {
  plaintext: string;
  senderDid: string;
  senderKeyAgreementPublicKey: string;
  senderKeyAgreementSecretKey: Uint8Array;
  recipientDids: string[];
}): Promise<EncryptedMessageBody> {
  const recipientBoxes: EncryptedRecipientBox[] = [];
  const recipientSet = [...new Set([input.senderDid, ...input.recipientDids])].sort();

  for (const recipientDid of recipientSet) {
    const resolved = await resolveDidDocument(recipientDid);
    const publicKeyMultibase = extractKeyAgreementPublicKeyMultibase(resolved.didDocument);
    const recipientPublicKey = decodeX25519Multibase(publicKeyMultibase);
    const nonce = randomBytes(nacl.box.nonceLength);
    const ciphertext = nacl.box(
      Buffer.from(input.plaintext, "utf8"),
      nonce,
      recipientPublicKey,
      input.senderKeyAgreementSecretKey
    );
    recipientBoxes.push({
      recipientDid,
      nonce: encodeBase64Url(nonce),
      ciphertext: encodeBase64Url(ciphertext)
    });
  }

  return {
    senderDid: input.senderDid,
    senderKeyAgreementPublicKey: input.senderKeyAgreementPublicKey,
    recipientBoxes
  };
}

export function decryptEncryptedMessageBody(input: {
  encryptedBody: EncryptedMessageBody;
  recipientDid: string;
  recipientKeyAgreementSecretKey: Uint8Array;
}): string {
  const recipientBox = input.encryptedBody.recipientBoxes.find((entry) => entry.recipientDid === input.recipientDid);
  if (!recipientBox) {
    throw new ProtocolConflictError(`Encrypted message body was not addressed to ${input.recipientDid}`);
  }

  const plaintext = nacl.box.open(
    decodeBase64Url(recipientBox.ciphertext),
    decodeBase64Url(recipientBox.nonce),
    Buffer.from(input.encryptedBody.senderKeyAgreementPublicKey, "hex"),
    input.recipientKeyAgreementSecretKey
  );
  if (!plaintext) {
    throw new ProtocolConflictError("Failed to decrypt the message body");
  }

  return Buffer.from(plaintext).toString("utf8");
}

export function applySpaceEvent(
  currentState: SpaceState | undefined,
  envelope: ProtocolEnvelope
): SpaceState {
  if (envelope.objectKind !== "space") {
    throw new ProtocolValidationError("Envelope is not a space event");
  }

  ensureLatestPredecessor(currentState, envelope, "space.created");
  switch (envelope.eventKind) {
    case "space.created": {
      const payload = envelope.payload as unknown as {
        spaceKind: SpaceKind;
        ownerRef: OwnerRef;
        membershipPolicy: MembershipPolicy;
        encryptionPolicy: EncryptionPolicy;
      };
      if (payload.membershipPolicy.ownerMemberDids.length === 0) {
        throw new ProtocolValidationError("Space membershipPolicy.ownerMemberDids must not be empty");
      }
      return {
        objectId: envelope.objectId,
        spaceId: envelope.objectId,
        spaceKind: payload.spaceKind,
        ownerRef: payload.ownerRef,
        membershipPolicy: payload.membershipPolicy,
        encryptionPolicy: payload.encryptionPolicy,
        status: "active",
        latestEventId: envelope.eventId,
        eventIds: [envelope.eventId]
      };
    }
    case "space.archived":
      if (!currentState) {
        throw new ProtocolConflictError("Cannot archive a space before it is created");
      }
      return {
        ...currentState,
        status: "archived",
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    default:
      throw new ProtocolValidationError(`Unsupported space event: ${envelope.eventKind}`);
  }
}

export function applySpaceMembershipEvent(
  currentState: SpaceMembershipState | undefined,
  envelope: ProtocolEnvelope,
  refs: {
    spaces: Map<string, SpaceState>;
    memberships: Map<string, SpaceMembershipState>;
  }
): SpaceMembershipState {
  if (envelope.objectKind !== "space-membership") {
    throw new ProtocolValidationError("Envelope is not a space-membership event");
  }

  ensureLatestPredecessor(currentState, envelope, "space-membership.member-added");
  switch (envelope.eventKind) {
    case "space-membership.member-added": {
      const payload = envelope.payload as { spaceId: string; memberDid: string; role: SpaceMembershipState["role"] };
      const space = refs.spaces.get(payload.spaceId);
      if (!space) {
        throw new ProtocolConflictError("Space membership target space does not exist");
      }
      if (currentState) {
        throw new ProtocolConflictError("space-membership.member-added cannot be appended twice");
      }
      if (
        refs.memberships.size > 0 &&
        !space.membershipPolicy.ownerMemberDids.includes(envelope.actorDid) &&
        activeMembersForSpace(payload.spaceId, refs.memberships).size > 0
      ) {
        assertCanManageMembership(space, envelope.actorDid, refs.memberships);
      }
      return {
        objectId: envelope.objectId,
        spaceId: payload.spaceId,
        memberDid: payload.memberDid,
        role: payload.role,
        status: "active",
        latestEventId: envelope.eventId,
        eventIds: [envelope.eventId]
      };
    }
    case "space-membership.member-removed":
      if (!currentState) {
        throw new ProtocolConflictError("Cannot remove a space member before it is added");
      }
      assertCanManageMembership(refs.spaces.get(currentState.spaceId)!, envelope.actorDid, refs.memberships);
      return {
        ...currentState,
        status: "removed",
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    case "space-membership.member-muted":
      if (!currentState) {
        throw new ProtocolConflictError("Cannot mute a space member before it is added");
      }
      assertCanManageMembership(refs.spaces.get(currentState.spaceId)!, envelope.actorDid, refs.memberships);
      return {
        ...currentState,
        status: "muted",
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    case "space-membership.member-role-updated": {
      if (!currentState) {
        throw new ProtocolConflictError("Cannot update a space member role before it is added");
      }
      assertCanManageMembership(refs.spaces.get(currentState.spaceId)!, envelope.actorDid, refs.memberships);
      const role = String((envelope.payload as Record<string, unknown>).role ?? "") as SpaceMembershipState["role"];
      return {
        ...currentState,
        role,
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    default:
      throw new ProtocolValidationError(`Unsupported space-membership event: ${envelope.eventKind}`);
  }
}

export function applyMessageEvent(
  currentState: MessageState | undefined,
  envelope: ProtocolEnvelope,
  refs: {
    spaces: Map<string, SpaceState>;
    memberships: Map<string, SpaceMembershipState>;
  }
): MessageState {
  if (envelope.objectKind !== "message") {
    throw new ProtocolValidationError("Envelope is not a message event");
  }

  ensureLatestPredecessor(currentState, envelope, "message.sent");
  switch (envelope.eventKind) {
    case "message.sent": {
      const payload = envelope.payload as unknown as {
        spaceId: string;
        messageType: string;
        metadata: ProtocolJsonObject;
        encryptedBody: EncryptedMessageBody;
        sentAt?: string;
      };
      const space = refs.spaces.get(payload.spaceId);
      if (!space) {
        throw new ProtocolConflictError("Message target space does not exist");
      }
      assertActiveMember(payload.spaceId, envelope.actorDid, refs.memberships);
      if (space.status !== "active") {
        throw new ProtocolConflictError("Messages cannot be sent to an archived space");
      }
      if (payload.encryptedBody.senderDid !== envelope.actorDid) {
        throw new ProtocolConflictError("Encrypted message senderDid must match the actor DID");
      }
      if (payload.sentAt) {
        assertIsoTimestamp(payload.sentAt, "Message.sentAt");
      }
      return {
        objectId: envelope.objectId,
        spaceId: payload.spaceId,
        senderDid: envelope.actorDid,
        messageType: payload.messageType,
        metadata: payload.metadata,
        encryptedBody: payload.encryptedBody,
        status: "sent",
        reactions: {},
        latestEventId: envelope.eventId,
        eventIds: [envelope.eventId]
      };
    }
    case "message.edited": {
      if (!currentState) {
        throw new ProtocolConflictError("Cannot edit a message before it is sent");
      }
      if (currentState.senderDid !== envelope.actorDid) {
        throw new ProtocolConflictError("Only the sender can edit a message");
      }
      const payload = envelope.payload as unknown as { metadata?: ProtocolJsonObject; encryptedBody: EncryptedMessageBody };
      return {
        ...currentState,
        metadata: payload.metadata ?? currentState.metadata,
        encryptedBody: payload.encryptedBody,
        status: "edited",
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    case "message.deleted":
      if (!currentState) {
        throw new ProtocolConflictError("Cannot delete a message before it is sent");
      }
      if (currentState.senderDid !== envelope.actorDid) {
        throw new ProtocolConflictError("Only the sender can delete a message");
      }
      return {
        ...currentState,
        status: "deleted",
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    case "message.reacted": {
      if (!currentState) {
        throw new ProtocolConflictError("Cannot react to a message before it is sent");
      }
      assertActiveMember(currentState.spaceId, envelope.actorDid, refs.memberships);
      const reaction = String((envelope.payload as Record<string, unknown>).reaction ?? "");
      assertNonEmpty(reaction, "Message.reaction");
      return {
        ...currentState,
        reactions: {
          ...currentState.reactions,
          [reaction]: [...new Set([...(currentState.reactions[reaction] ?? []), envelope.actorDid])].sort()
        },
        latestEventId: envelope.eventId,
        eventIds: [...currentState.eventIds, envelope.eventId]
      };
    }
    default:
      throw new ProtocolValidationError(`Unsupported message event: ${envelope.eventKind}`);
  }
}

export function spacePayloadToJson(payload: Omit<SpaceState, "objectId" | "spaceId" | "status" | "latestEventId" | "eventIds">): ProtocolJsonObject {
  return payload as unknown as ProtocolJsonObject;
}

export function spaceMembershipPayloadToJson(
  payload: Omit<SpaceMembershipState, "objectId" | "status" | "latestEventId" | "eventIds">
): ProtocolJsonObject {
  return payload as unknown as ProtocolJsonObject;
}

export function messageSentPayloadToJson(payload: {
  spaceId: string;
  messageType: string;
  metadata: ProtocolJsonObject;
  encryptedBody: EncryptedMessageBody;
  sentAt?: string;
}): ProtocolJsonObject {
  return payload as unknown as ProtocolJsonObject;
}
