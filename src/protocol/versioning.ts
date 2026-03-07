export const LEGACY_EMPORION_PROTOCOL = "emporion.protocol";
export const LEGACY_EMPORION_PROTOCOL_VERSION = 1;

export type ProtocolFamily =
  | "emporion.identity"
  | "emporion.company"
  | "emporion.market"
  | "emporion.contract"
  | "emporion.messaging";

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

export interface ProtocolVersion {
  major: number;
  minor: number;
}

export type ProtocolVersionString = `${number}.${number}`;

export interface SupportedProtocolDescriptor {
  protocol: ProtocolFamily;
  supportedMajorVersions: number[];
  latestVersion: ProtocolVersionString;
}

const PROTOCOL_FAMILY_BY_OBJECT_KIND: Record<ProtocolObjectKind, ProtocolFamily> = {
  "agent-profile": "emporion.identity",
  company: "emporion.company",
  product: "emporion.market",
  listing: "emporion.market",
  request: "emporion.market",
  offer: "emporion.market",
  bid: "emporion.market",
  agreement: "emporion.market",
  "feedback-credential-ref": "emporion.identity",
  contract: "emporion.contract",
  "evidence-bundle": "emporion.contract",
  "oracle-attestation": "emporion.contract",
  "dispute-case": "emporion.contract",
  space: "emporion.messaging",
  "space-membership": "emporion.messaging",
  message: "emporion.messaging"
};

const LATEST_PROTOCOL_VERSION_BY_FAMILY: Record<ProtocolFamily, ProtocolVersion> = {
  "emporion.identity": { major: 1, minor: 0 },
  "emporion.company": { major: 1, minor: 0 },
  "emporion.market": { major: 1, minor: 0 },
  "emporion.contract": { major: 1, minor: 0 },
  "emporion.messaging": { major: 1, minor: 0 }
};

const SUPPORTED_PROTOCOL_MAJOR_VERSIONS: Record<ProtocolFamily, readonly number[]> = {
  "emporion.identity": [1],
  "emporion.company": [1],
  "emporion.market": [1],
  "emporion.contract": [1],
  "emporion.messaging": [1]
};

export function isProtocolObjectKind(value: string): value is ProtocolObjectKind {
  return value in PROTOCOL_FAMILY_BY_OBJECT_KIND;
}

export function protocolFamilyForObjectKind(objectKind: ProtocolObjectKind): ProtocolFamily {
  return PROTOCOL_FAMILY_BY_OBJECT_KIND[objectKind];
}

export function latestProtocolVersionForFamily(protocol: ProtocolFamily): ProtocolVersion {
  return LATEST_PROTOCOL_VERSION_BY_FAMILY[protocol];
}

export function formatProtocolVersion(version: ProtocolVersion): ProtocolVersionString {
  return `${version.major}.${version.minor}`;
}

export function parseProtocolVersion(version: string): ProtocolVersion {
  const match = /^(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Protocol version must use <major>.<minor> format: ${version}`);
  }

  return {
    major: Number.parseInt(match[1] ?? "", 10),
    minor: Number.parseInt(match[2] ?? "", 10)
  };
}

export function isSupportedProtocolMajor(protocol: ProtocolFamily, major: number): boolean {
  return SUPPORTED_PROTOCOL_MAJOR_VERSIONS[protocol].includes(major);
}

export function getSupportedProtocolDescriptors(): SupportedProtocolDescriptor[] {
  return (Object.keys(LATEST_PROTOCOL_VERSION_BY_FAMILY) as ProtocolFamily[])
    .map((protocol) => ({
      protocol,
      supportedMajorVersions: [...SUPPORTED_PROTOCOL_MAJOR_VERSIONS[protocol]],
      latestVersion: formatProtocolVersion(LATEST_PROTOCOL_VERSION_BY_FAMILY[protocol])
    }))
    .sort((left, right) => left.protocol.localeCompare(right.protocol));
}
