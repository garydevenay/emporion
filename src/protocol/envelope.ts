import bs58 from "bs58";
import nacl from "tweetnacl";

import { resolveDidDocument } from "../did.js";
import { ProtocolValidationError } from "../errors.js";
import type { DidDocumentLike } from "../types.js";
import {
  assertIsoTimestamp,
  canonicalJsonStringify,
  decodeBase64Url,
  encodeBase64Url,
  sha256Hex,
  type ProtocolJsonObject,
  type ProtocolValue
} from "./shared.js";

export const EMPORION_PROTOCOL = "emporion.protocol";
export const EMPORION_PROTOCOL_VERSION = 1;

export type ProtocolObjectKind =
  | "agent-profile"
  | "company"
  | "product"
  | "listing"
  | "request"
  | "offer"
  | "bid"
  | "agreement"
  | "feedback-credential-ref"
  | "contract"
  | "evidence-bundle"
  | "oracle-attestation"
  | "dispute-case"
  | "space"
  | "space-membership"
  | "message";

export interface ProtocolAttachment {
  kind: string;
  hash: string;
  mediaType?: string;
  uri?: string;
}

export interface ProtocolSignature {
  algorithm: "ed25519";
  signerDid: string;
  publicKeyMultibase: string;
  value: string;
}

export interface ProtocolEnvelope<TPayload extends ProtocolJsonObject = ProtocolJsonObject> {
  protocol: typeof EMPORION_PROTOCOL;
  version: typeof EMPORION_PROTOCOL_VERSION;
  objectKind: ProtocolObjectKind;
  objectId: string;
  eventKind: string;
  eventId: string;
  actorDid: string;
  subjectId: string;
  issuedAt: string;
  previousEventIds: string[];
  payload: TPayload;
  attachments: ProtocolAttachment[];
  signature: ProtocolSignature;
}

export type UnsignedProtocolEnvelope<TPayload extends ProtocolJsonObject = ProtocolJsonObject> = Omit<
  ProtocolEnvelope<TPayload>,
  "eventId" | "signature"
>;

export interface ProtocolValidationIssue {
  code:
    | "invalid-protocol"
    | "unsupported-version"
    | "invalid-object-kind"
    | "invalid-event-id"
    | "invalid-signature"
    | "invalid-previous-event-chain"
    | "invalid-attachment"
    | "invalid-timestamp";
  message: string;
}

export interface ProtocolValidationResult {
  ok: boolean;
  issues: ProtocolValidationIssue[];
}

export interface ProtocolSigner {
  did: string;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

function toUnsignedRecord(envelope: UnsignedProtocolEnvelope): ProtocolJsonObject {
  return {
    protocol: envelope.protocol,
    version: envelope.version,
    objectKind: envelope.objectKind,
    objectId: envelope.objectId,
    eventKind: envelope.eventKind,
    actorDid: envelope.actorDid,
    subjectId: envelope.subjectId,
    issuedAt: envelope.issuedAt,
    previousEventIds: [...envelope.previousEventIds],
    payload: envelope.payload,
    attachments: envelope.attachments as unknown as ProtocolValue[]
  };
}

function toSignedRecord(envelope: ProtocolEnvelope): ProtocolJsonObject {
  return {
    ...toUnsignedRecord(envelope),
    eventId: envelope.eventId
  };
}

function validateAttachments(attachments: ProtocolAttachment[]): void {
  for (const attachment of attachments) {
    if (attachment.kind.trim().length === 0) {
      throw new ProtocolValidationError("ProtocolAttachment.kind must not be blank");
    }
    if (!/^[a-f0-9]{64}$/i.test(attachment.hash)) {
      throw new ProtocolValidationError("ProtocolAttachment.hash must be a 32-byte hex hash");
    }
  }
}

function decodeMultibaseEd25519Key(publicKeyMultibase: string): Uint8Array {
  if (!publicKeyMultibase.startsWith("z")) {
    throw new ProtocolValidationError("Only base58-btc multibase keys are supported");
  }

  const decoded = Buffer.from(bs58.decode(publicKeyMultibase.slice(1)));
  if (decoded.byteLength < 3) {
    throw new ProtocolValidationError("publicKeyMultibase is too short");
  }
  if (decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new ProtocolValidationError("publicKeyMultibase is not an Ed25519 multicodec");
  }

  return decoded.subarray(2);
}

function extractVerificationKey(didDocument: DidDocumentLike): string {
  const authenticationRef = didDocument.authentication?.[0];
  if (typeof authenticationRef === "string") {
    const verificationMethod = didDocument.verificationMethod?.find((entry) => entry.id === authenticationRef);
    if (!verificationMethod?.publicKeyMultibase) {
      throw new ProtocolValidationError(`DID document ${didDocument.id} does not expose the authentication key`);
    }
    return verificationMethod.publicKeyMultibase;
  }
  if (authenticationRef && "publicKeyMultibase" in authenticationRef && authenticationRef.publicKeyMultibase) {
    return authenticationRef.publicKeyMultibase;
  }

  const verificationMethod = didDocument.verificationMethod?.find(
    (entry) =>
      !!entry.publicKeyMultibase &&
      !/keyagreement/i.test(entry.type) &&
      !/x25519/i.test(entry.type)
  );
  if (!verificationMethod?.publicKeyMultibase) {
    throw new ProtocolValidationError(`DID document ${didDocument.id} does not expose a verification key`);
  }

  return verificationMethod.publicKeyMultibase;
}

export function deriveProtocolEventId(envelope: UnsignedProtocolEnvelope): string {
  return sha256Hex(toUnsignedRecord(envelope));
}

export function signProtocolEnvelope<TPayload extends ProtocolJsonObject>(
  envelope: UnsignedProtocolEnvelope<TPayload>,
  signer: ProtocolSigner
): ProtocolEnvelope<TPayload> {
  if (envelope.actorDid !== signer.did) {
    throw new ProtocolValidationError("Envelope actorDid must match signer.did");
  }

  validateAttachments(envelope.attachments);
  assertIsoTimestamp(envelope.issuedAt, "ProtocolEnvelope.issuedAt");

  const eventId = deriveProtocolEventId(envelope);
  const signingRecord = {
    ...toUnsignedRecord(envelope),
    eventId
  };
  const message = Buffer.from(canonicalJsonStringify(signingRecord), "utf8");
  const signatureBytes = nacl.sign.detached(message, signer.secretKey);
  const signature: ProtocolSignature = {
    algorithm: "ed25519",
    signerDid: signer.did,
    publicKeyMultibase: `z${bs58.encode(Buffer.from([0xed, 0x01, ...signer.publicKey]))}`,
    value: encodeBase64Url(signatureBytes)
  };

  return {
    ...envelope,
    eventId,
    signature
  };
}

export function validateEnvelopeShape(envelope: ProtocolEnvelope): ProtocolValidationResult {
  const issues: ProtocolValidationIssue[] = [];

  if (envelope.protocol !== EMPORION_PROTOCOL) {
    issues.push({ code: "invalid-protocol", message: `Unsupported protocol: ${envelope.protocol}` });
  }
  if (envelope.version !== EMPORION_PROTOCOL_VERSION) {
    issues.push({ code: "unsupported-version", message: `Unsupported protocol version: ${envelope.version}` });
  }
  if (!envelope.objectKind) {
    issues.push({ code: "invalid-object-kind", message: "objectKind is required" });
  }
  try {
    assertIsoTimestamp(envelope.issuedAt, "ProtocolEnvelope.issuedAt");
  } catch (error) {
    issues.push({ code: "invalid-timestamp", message: (error as Error).message });
  }
  try {
    validateAttachments(envelope.attachments);
  } catch (error) {
    issues.push({ code: "invalid-attachment", message: (error as Error).message });
  }
  const derivedEventId = deriveProtocolEventId(envelope);
  if (derivedEventId !== envelope.eventId) {
    issues.push({ code: "invalid-event-id", message: "eventId does not match the canonical envelope hash" });
  }

  return {
    ok: issues.length === 0,
    issues
  };
}

export async function verifyProtocolEnvelopeSignature(envelope: ProtocolEnvelope): Promise<void> {
  const shape = validateEnvelopeShape(envelope);
  if (!shape.ok) {
    throw new ProtocolValidationError(shape.issues.map((issue) => issue.message).join("; "));
  }

  const resolved = await resolveDidDocument(envelope.actorDid);
  const resolvedPublicKey = extractVerificationKey(resolved.didDocument);
  if (resolvedPublicKey !== envelope.signature.publicKeyMultibase) {
    throw new ProtocolValidationError("Envelope signature key does not match the actor DID document");
  }

  const publicKey = decodeMultibaseEd25519Key(resolvedPublicKey);
  const message = Buffer.from(canonicalJsonStringify(toSignedRecord(envelope)), "utf8");
  const signatureBytes = decodeBase64Url(envelope.signature.value);
  if (!nacl.sign.detached.verify(message, signatureBytes, publicKey)) {
    throw new ProtocolValidationError("Envelope signature verification failed");
  }
}

export function createUnsignedEnvelope<TPayload extends ProtocolJsonObject>(input: {
  objectKind: ProtocolObjectKind;
  objectId: string;
  eventKind: string;
  actorDid: string;
  subjectId: string;
  issuedAt: string;
  previousEventIds?: string[];
  payload: TPayload;
  attachments?: ProtocolAttachment[];
}): UnsignedProtocolEnvelope<TPayload> {
  return {
    protocol: EMPORION_PROTOCOL,
    version: EMPORION_PROTOCOL_VERSION,
    objectKind: input.objectKind,
    objectId: input.objectId,
    eventKind: input.eventKind,
    actorDid: input.actorDid,
    subjectId: input.subjectId,
    issuedAt: input.issuedAt,
    previousEventIds: [...(input.previousEventIds ?? [])],
    payload: input.payload,
    attachments: [...(input.attachments ?? [])]
  };
}
