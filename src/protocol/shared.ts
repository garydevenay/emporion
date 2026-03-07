import { createHash } from "node:crypto";

export type ProtocolScalar = null | boolean | number | string;
export type ProtocolValue = ProtocolScalar | ProtocolValue[] | { [key: string]: ProtocolValue };

export type ProtocolJsonObject = { [key: string]: ProtocolValue };

function normalizeValue(value: ProtocolValue): ProtocolValue {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry));
  }

  if (value && typeof value === "object") {
    const normalized: ProtocolJsonObject = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeValue(value[key] as ProtocolValue);
    }
    return normalized;
  }

  return value;
}

export function canonicalizeProtocolValue<T extends ProtocolValue>(value: T): T {
  return normalizeValue(value) as T;
}

export function canonicalJsonStringify(value: ProtocolValue): string {
  return JSON.stringify(canonicalizeProtocolValue(value));
}

export function sha256Hex(value: ProtocolValue | string | Buffer): string {
  const hash = createHash("sha256");
  if (typeof value === "string" || Buffer.isBuffer(value)) {
    hash.update(value);
  } else {
    hash.update(canonicalJsonStringify(value), "utf8");
  }
  return hash.digest("hex");
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function decodeBase64Url(value: string): Uint8Array {
  return Buffer.from(value, "base64url");
}

export function assertIsoTimestamp(value: string, fieldName: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
    throw new Error(`${fieldName} must be an ISO-8601 UTC timestamp`);
  }
}

export function safeFeedComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_");
}
