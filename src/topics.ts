import { createHash } from "node:crypto";

import { TopicValidationError } from "./errors.js";
import type { TopicRef } from "./types.js";

function assertIdentifier(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new TopicValidationError(`${fieldName} must not be blank`);
  }

  if (!/^[a-zA-Z0-9:._-]+$/.test(trimmed)) {
    throw new TopicValidationError(`${fieldName} contains unsupported characters`);
  }

  return trimmed;
}

export function topicRefToCanonicalString(ref: TopicRef): string {
  switch (ref.kind) {
    case "agent":
      return `agent:${assertIdentifier(ref.agentDid, "TopicRef.agentDid")}`;
    case "company":
      return `company:${assertIdentifier(ref.companyId, "TopicRef.companyId")}`;
    case "marketplace":
      return `marketplace:${assertIdentifier(ref.marketplaceId, "TopicRef.marketplaceId")}`;
  }
}

export function topicRefToDiscoveryKey(ref: TopicRef): Buffer {
  const canonical = topicRefToCanonicalString(ref);
  return createHash("sha256").update(`emporion-topic:${canonical}`, "utf8").digest();
}
