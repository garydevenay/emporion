import { Buffer } from "node:buffer";

import bs58 from "bs58";
import { Resolver } from "did-resolver";
import * as KeyDidResolver from "key-did-resolver";
import { getResolver as getPeerDidResolver } from "peer-did-resolver";

import { DidResolutionError } from "./errors.js";
import type {
  DidDocumentLike,
  DidServiceLike,
  ResolvedDidDocument,
  TransportServiceEndpoint
} from "./types.js";

const ED25519_MULTICODEC_PREFIX = Buffer.from([0xed, 0x01]);
const X25519_MULTICODEC_PREFIX = Buffer.from([0xec, 0x01]);
const EMPORION_TRANSPORT_SERVICE_TYPE = "EmporionTransportService";

const resolver = new Resolver({
  ...getPeerDidResolver(),
  ...KeyDidResolver.getResolver()
});

function toBase58Multibase(bytes: Buffer): string {
  return `z${bs58.encode(bytes)}`;
}

function encodeServiceBlock(service: DidServiceLike): string {
  const json = JSON.stringify(service);
  return Buffer.from(json, "utf8").toString("base64url");
}

function decodeHexPublicKey(hexValue: string, fieldName: string): Buffer {
  if (!/^[a-f0-9]{64}$/i.test(hexValue)) {
    throw new DidResolutionError(`${fieldName} must be a 32-byte hex string`);
  }

  return Buffer.from(hexValue, "hex");
}

export function publicKeyToMultibase(publicKey: Buffer): string {
  return toBase58Multibase(Buffer.concat([ED25519_MULTICODEC_PREFIX, publicKey]));
}

export function keyAgreementPublicKeyToMultibase(publicKey: Buffer): string {
  return toBase58Multibase(Buffer.concat([X25519_MULTICODEC_PREFIX, publicKey]));
}

export function publicKeyToDidKey(publicKey: Buffer): string {
  return `did:key:${publicKeyToMultibase(publicKey)}`;
}

export function createEmporionTransportDidDocument(
  did: string,
  noisePublicKeyHex: string,
  keyAgreementPublicKeyHex: string,
  controlFeedKeyHex: string
): DidDocumentLike {
  const noisePublicKey = decodeHexPublicKey(noisePublicKeyHex, "noisePublicKeyHex");
  const keyAgreementPublicKey = decodeHexPublicKey(keyAgreementPublicKeyHex, "keyAgreementPublicKeyHex");
  const verificationMethodId = `${did}#transport-key-1`;
  const keyAgreementMethodId = `${did}#key-agreement-1`;
  const serviceId = `${did}#transport`;

  return {
    id: did,
    verificationMethod: [
      {
        id: verificationMethodId,
        type: "Ed25519VerificationKey2020",
        controller: did,
        publicKeyMultibase: publicKeyToMultibase(noisePublicKey)
      },
      {
        id: keyAgreementMethodId,
        type: "X25519KeyAgreementKey2020",
        controller: did,
        publicKeyMultibase: keyAgreementPublicKeyToMultibase(keyAgreementPublicKey)
      }
    ],
    authentication: [verificationMethodId],
    assertionMethod: [verificationMethodId],
    keyAgreement: [keyAgreementMethodId],
    service: [
      {
        id: serviceId,
        type: EMPORION_TRANSPORT_SERVICE_TYPE,
        serviceEndpoint: {
          protocolVersion: 1,
          noisePublicKey: noisePublicKeyHex,
          controlFeedKey: controlFeedKeyHex
        }
      }
    ]
  };
}

export function createPeerDid(
  noisePublicKeyHex: string,
  keyAgreementPublicKeyHex: string,
  controlFeedKeyHex: string
): { did: string; didDocument: DidDocumentLike } {
  const noisePublicKey = decodeHexPublicKey(noisePublicKeyHex, "noisePublicKeyHex");
  const keyAgreementPublicKey = decodeHexPublicKey(keyAgreementPublicKeyHex, "keyAgreementPublicKeyHex");
  const verificationMethodMultibase = publicKeyToMultibase(noisePublicKey);
  const keyAgreementMultibase = keyAgreementPublicKeyToMultibase(keyAgreementPublicKey);
  const provisionalDid = `did:peer:2.V${verificationMethodMultibase}.E${keyAgreementMultibase}`;
  const service: DidServiceLike = {
    id: "#transport",
    type: EMPORION_TRANSPORT_SERVICE_TYPE,
    serviceEndpoint: {
      protocolVersion: 1,
      noisePublicKey: noisePublicKeyHex,
      controlFeedKey: controlFeedKeyHex
    }
  };
  const did = `${provisionalDid}.S${encodeServiceBlock(service)}`;

  return {
    did,
    didDocument: createEmporionTransportDidDocument(did, noisePublicKeyHex, keyAgreementPublicKeyHex, controlFeedKeyHex)
  };
}

function isDidDocumentLike(value: unknown): value is DidDocumentLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return typeof (value as Record<string, unknown>).id === "string";
}

export async function resolveDidDocument(did: string): Promise<ResolvedDidDocument> {
  const result = await resolver.resolve(did);
  if (!isDidDocumentLike(result.didDocument)) {
    throw new DidResolutionError(`DID did not resolve to a document: ${did}`);
  }

  return {
    did,
    didDocument: result.didDocument
  };
}

function normalizeServiceEndpoint(value: unknown): TransportServiceEndpoint | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const endpoint = value as Record<string, unknown>;
  if (
    endpoint.protocolVersion !== 1 ||
    typeof endpoint.noisePublicKey !== "string" ||
    typeof endpoint.controlFeedKey !== "string"
  ) {
    return null;
  }

  return {
    protocolVersion: 1,
    noisePublicKey: endpoint.noisePublicKey,
    controlFeedKey: endpoint.controlFeedKey
  };
}

export function extractEmporionTransportService(didDocument: DidDocumentLike): TransportServiceEndpoint {
  const service = didDocument.service?.find((entry) => entry.type === EMPORION_TRANSPORT_SERVICE_TYPE);
  if (!service) {
    throw new DidResolutionError(`DID document does not expose ${EMPORION_TRANSPORT_SERVICE_TYPE}`);
  }

  const endpoint = normalizeServiceEndpoint(service.serviceEndpoint);
  if (!endpoint) {
    throw new DidResolutionError(`DID document contains an invalid ${EMPORION_TRANSPORT_SERVICE_TYPE}`);
  }

  return endpoint;
}

export function extractKeyAgreementPublicKeyMultibase(didDocument: DidDocumentLike): string {
  const keyAgreement = didDocument.keyAgreement?.[0];
  if (!keyAgreement) {
    throw new DidResolutionError(`DID document ${didDocument.id} does not expose a keyAgreement method`);
  }

  if (typeof keyAgreement === "string") {
    const resolved = didDocument.verificationMethod?.find((entry) => entry.id === keyAgreement);
    if (!resolved?.publicKeyMultibase) {
      throw new DidResolutionError(`DID document ${didDocument.id} keyAgreement reference did not resolve`);
    }
    return resolved.publicKeyMultibase;
  }

  if (!keyAgreement.publicKeyMultibase) {
    throw new DidResolutionError(`DID document ${didDocument.id} keyAgreement method did not include a multibase key`);
  }

  return keyAgreement.publicKeyMultibase;
}
