export { AgentTransport } from "./transport.js";
export { normalizeTransportConfig } from "./config.js";
export * as Protocol from "./protocol/index.js";
export { topicRefToCanonicalString, topicRefToDiscoveryKey } from "./topics.js";
export type {
  AgentIdentity,
  NormalizedTransportConfig,
  PeerHello,
  ReplicationDescriptor,
  TopicJoinOptions,
  TopicRef,
  TransportConfig,
  TransportServiceEndpoint
} from "./types.js";
