export { AgentTransport } from "./transport.js";
export { normalizeTransportConfig } from "./config.js";
export {
  AgentDaemon,
  getLocalControlEndpoint,
  type DaemonCommandRequest,
  type DaemonCommandResponse,
  type DaemonStatus,
  type LocalControlEndpoint
} from "./daemon.js";
export * as Protocol from "./protocol/index.js";
export { topicRefToCanonicalString, topicRefToDiscoveryKey } from "./topics.js";
export { WalletService } from "./wallet/service.js";
export { ContextStore, EMPORION_CONTEXTS_FILE_ENV } from "./context-store.js";
export { DealsStore, type DealRecord, type DealStage } from "./experience/deals-store.js";
export {
  NostrWalletConnectAdapter,
  isNostrWalletConnectUri,
  parseNostrWalletConnectMetadata
} from "./wallet/nostr-nwc-adapter.js";
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
export type {
  AutoSettleRecord,
  CreateInvoiceResult,
  DaemonWalletStatus,
  InvoiceRecord,
  PaymentRecord,
  WalletConnectionConfig,
  WalletConnectionMetadata,
  WalletStatus
} from "./wallet/types.js";
