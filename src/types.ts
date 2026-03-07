import type { LogLevel } from "./logger.js";

export interface ReconnectBackoffConfig {
  minMs: number;
  maxMs: number;
}

export interface TransportConfig {
  dataDir: string;
  bootstrap?: string[] | undefined;
  maxPeers?: number;
  handshakeTimeoutMs?: number;
  reconnectBackoff?: ReconnectBackoffConfig;
  logLevel?: LogLevel;
}

export interface NormalizedTransportConfig {
  dataDir: string;
  bootstrap: string[] | undefined;
  maxPeers: number;
  handshakeTimeoutMs: number;
  reconnectBackoff: ReconnectBackoffConfig;
  logLevel: LogLevel;
}

export type TopicKind = "agent" | "company" | "marketplace";

export interface AgentTopicRef {
  kind: "agent";
  agentDid: string;
}

export interface CompanyTopicRef {
  kind: "company";
  companyId: string;
}

export interface MarketplaceTopicRef {
  kind: "marketplace";
  marketplaceId: string;
}

export type TopicRef = AgentTopicRef | CompanyTopicRef | MarketplaceTopicRef;

export interface TopicJoinOptions {
  server?: boolean;
  client?: boolean;
}

export interface TopicJoinState {
  ref: TopicRef;
  key: string;
  server: boolean;
  client: boolean;
}

export interface ReplicationDescriptor {
  name: string;
  key: string;
  kind: "feed" | "index";
}

export interface PeerHello {
  protocolVersion: 1;
  agentDid: string;
  capabilities: string[];
  controlFeedKey: string;
  joinedTopics: string[];
  replication: ReplicationDescriptor[];
}

export interface AgentIdentity {
  did: string;
  didDocument: DidDocumentLike;
  noisePublicKey: string;
  keyAgreementPublicKey: string;
  controlFeedKey: string;
}

export interface DidVerificationMethodLike {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase?: string;
}

export interface DidServiceLike {
  id: string;
  type: string;
  serviceEndpoint: unknown;
}

export interface DidDocumentLike {
  id: string;
  verificationMethod?: DidVerificationMethodLike[];
  authentication?: Array<string | DidVerificationMethodLike>;
  assertionMethod?: Array<string | DidVerificationMethodLike>;
  keyAgreement?: Array<string | DidVerificationMethodLike>;
  service?: DidServiceLike[];
}

export interface TransportServiceEndpoint {
  protocolVersion: 1;
  noisePublicKey: string;
  controlFeedKey: string;
}

export interface ResolvedDidDocument {
  did: string;
  didDocument: DidDocumentLike;
}
