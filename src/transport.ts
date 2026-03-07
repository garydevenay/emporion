import { mkdir } from "node:fs/promises";
import { once } from "node:events";

import DHT from "hyperdht";
import Hyperswarm from "hyperswarm";

import { normalizeTransportConfig } from "./config.js";
import { extractEmporionTransportService, resolveDidDocument } from "./did.js";
import { ConnectionRejectedError } from "./errors.js";
import { performPeerHandshake } from "./handshake.js";
import type { NoiseSocket } from "./handshake.js";
import { loadIdentityMaterial, persistAgentIdentity, type IdentityMaterial } from "./identity.js";
import { createLogger, type Logger } from "./logger.js";
import { getSupportedProtocolDescriptors } from "./protocol/versioning.js";
import { TransportStorage } from "./storage.js";
import { topicRefToCanonicalString, topicRefToDiscoveryKey } from "./topics.js";
import type {
  AgentIdentity,
  NormalizedTransportConfig,
  PeerHello,
  ReplicationDescriptor,
  TopicJoinState,
  TopicJoinOptions,
  TopicRef,
  TransportConfig
} from "./types.js";

export interface PeerSession {
  remoteDid: string;
  remoteNoisePublicKey: string;
  remoteControlFeedKey: string;
  source: string;
  supportedProtocols: PeerHello["supportedProtocols"];
  replication: ReplicationDescriptor[];
}

type DiscoveryHandle = ReturnType<Hyperswarm["join"]>;

function waitForSocketOpen(socket: NoiseSocket, timeoutMs: number): Promise<void> {
  if (socket.remotePublicKey) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new ConnectionRejectedError(`Timed out waiting for socket open after ${timeoutMs}ms`));
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
    }

    function onOpen(): void {
      cleanup();
      resolve();
    }

    function onError(error: Error): void {
      cleanup();
      reject(new ConnectionRejectedError("Socket failed before opening", { cause: error }));
    }

    function onClose(): void {
      cleanup();
      reject(new ConnectionRejectedError("Socket closed before opening"));
    }

    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function normalizeJoinOptions(options?: TopicJoinOptions): Required<TopicJoinOptions> {
  return {
    server: options?.server ?? true,
    client: options?.client ?? true
  };
}

export class AgentTransport {
  public static async create(config: TransportConfig): Promise<AgentTransport> {
    const normalizedConfig = normalizeTransportConfig(config);
    await mkdir(normalizedConfig.dataDir, { recursive: true });
    const logger = createLogger(normalizedConfig.logLevel);

    const provisionalIdentity = await loadIdentityMaterial(normalizedConfig.dataDir, "0".repeat(64));
    const storage = await TransportStorage.create(
      normalizedConfig.dataDir,
      provisionalIdentity.storagePrimaryKey,
      logger
    );
    const defaults = await storage.initializeDefaults();
    const identityMaterial = await loadIdentityMaterial(normalizedConfig.dataDir, defaults.controlDescriptor.key);
    await persistAgentIdentity(normalizedConfig.dataDir, identityMaterial.agentIdentity);

    const dht = new DHT({
      bootstrap: normalizedConfig.bootstrap,
      keyPair: identityMaterial.transportKeyPair
    });
    const swarm = new Hyperswarm({
      dht,
      keyPair: identityMaterial.transportKeyPair,
      maxPeers: normalizedConfig.maxPeers
    });

    return new AgentTransport(normalizedConfig, logger, storage, identityMaterial, dht, swarm);
  }

  public readonly identity: AgentIdentity;

  private readonly logger: Logger;
  private readonly storage: TransportStorage;
  private readonly identityMaterial: IdentityMaterial;
  private readonly dht: DHT;
  private readonly swarm: Hyperswarm;
  private readonly config: NormalizedTransportConfig;
  private readonly joinedTopics = new Map<string, { ref: TopicRef; discovery: DiscoveryHandle; mode: Required<TopicJoinOptions> }>();
  private readonly activeSockets = new Set<NoiseSocket>();
  private readonly activePeerSessions = new Map<string, PeerSession>();
  private started = false;
  private stopping = false;
  private destroyed = false;

  private constructor(
    config: NormalizedTransportConfig,
    logger: Logger,
    storage: TransportStorage,
    identityMaterial: IdentityMaterial,
    dht: DHT,
    swarm: Hyperswarm
  ) {
    this.config = config;
    this.logger = logger;
    this.storage = storage;
    this.identityMaterial = identityMaterial;
    this.identity = identityMaterial.agentIdentity;
    this.dht = dht;
    this.swarm = swarm;
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (this.destroyed) {
      throw new ConnectionRejectedError("Agent transport cannot be restarted after stop()");
    }

    this.swarm.on("connection", (socket, info) => {
      void this.handleSocket(socket as NoiseSocket, {
        source: info.topics && info.topics.length > 0 ? "hyperswarm-topic" : "hyperswarm-direct"
      });
    });
    this.swarm.on("update", () => {
      this.logger.debug("Swarm state updated", {
        connecting: this.swarm.connecting,
        connected: this.swarm.connections.size
      });
    });
    this.swarm.on("ban", (_peerInfo, error) => {
      this.logger.warn("Peer was banned by the swarm", { error: error.message });
    });

    await this.swarm.listen();
    this.started = true;
    this.logger.info("Agent transport started", {
      did: this.identity.did,
      noisePublicKey: this.identity.noisePublicKey,
      controlFeedKey: this.identity.controlFeedKey,
      dataDir: this.config.dataDir
    });
  }

  public async stop(): Promise<void> {
    if (!this.started || this.stopping) {
      return;
    }

    this.stopping = true;
    this.logger.info("Stopping agent transport");

    for (const [key, state] of this.joinedTopics) {
      await state.discovery.destroy();
      this.joinedTopics.delete(key);
    }

    for (const socket of this.activeSockets) {
      socket.destroy();
    }

    await this.swarm.destroy();
    await this.storage.close();

    this.started = false;
    this.stopping = false;
    this.destroyed = true;
    this.logger.info("Agent transport stopped");
  }

  public async suspend(): Promise<void> {
    await this.swarm.suspend();
    this.logger.info("Agent transport suspended");
  }

  public async resume(): Promise<void> {
    await this.swarm.resume();
    this.logger.info("Agent transport resumed");
  }

  public async joinTopic(ref: TopicRef, options?: TopicJoinOptions): Promise<void> {
    this.ensureStarted();
    const key = topicRefToCanonicalString(ref);
    if (this.joinedTopics.has(key)) {
      return;
    }

    const mode = normalizeJoinOptions(options);
    const discovery = this.swarm.join(topicRefToDiscoveryKey(ref), mode);
    if (mode.server) {
      await discovery.flushed();
    }
    if (mode.client) {
      await this.swarm.flush();
    }

    this.joinedTopics.set(key, { ref, discovery, mode });
    this.logger.info("Joined topic", { topic: key, ...mode });
  }

  public async leaveTopic(ref: TopicRef): Promise<void> {
    this.ensureStarted();
    const key = topicRefToCanonicalString(ref);
    const state = this.joinedTopics.get(key);
    if (!state) {
      return;
    }

    await state.discovery.destroy();
    this.joinedTopics.delete(key);
    this.logger.info("Left topic", { topic: key });
  }

  public async connectToDid(did: string): Promise<void> {
    this.ensureStarted();
    const resolved = await resolveDidDocument(did);
    const endpoint = extractEmporionTransportService(resolved.didDocument);
    await this.connectToNoiseKey(endpoint.noisePublicKey);
  }

  public async connectToNoiseKey(publicKeyHex: string): Promise<void> {
    this.ensureStarted();
    const socket = this.dht.connect(Buffer.from(publicKeyHex, "hex"), {
      keyPair: this.identityMaterial.transportKeyPair
    }) as NoiseSocket;

    await waitForSocketOpen(socket, this.config.handshakeTimeoutMs);
    await this.handleSocket(socket, { source: "hyperdht-direct" }, true);
  }

  public async openFeed(name: string) {
    return this.storage.openFeed(name);
  }

  public async openIndex(name: string) {
    return this.storage.openIndex(name);
  }

  public getStorage(): TransportStorage {
    return this.storage;
  }

  public getIdentityMaterial(): IdentityMaterial {
    return this.identityMaterial;
  }

  public getPeerSessions(): ReadonlyMap<string, PeerSession> {
    return this.activePeerSessions;
  }

  public getJoinedTopics(): TopicJoinState[] {
    return [...this.joinedTopics.entries()]
      .map(([key, { ref, mode }]) => ({
        ref,
        key,
        server: mode.server,
        client: mode.client
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  public getRemoteFeed(key: string) {
    return this.storage.getRemoteFeed(key);
  }

  private async handleSocket(
    socket: NoiseSocket,
    metadata: { source: string },
    propagateFailure = false
  ): Promise<void> {
    this.activeSockets.add(socket);
    socket.once("close", () => {
      this.activeSockets.delete(socket);
    });
    socket.once("error", (error) => {
      this.logger.warn("Socket error", { source: metadata.source, error: error.message });
    });

    try {
      const remoteHello = await performPeerHandshake(socket, this.buildLocalHello(), this.config.handshakeTimeoutMs);
      const session = await this.validateRemoteHello(socket, remoteHello, metadata.source);
      await this.storage.trackRemoteDescriptors(remoteHello.replication);
      const replicationStream = this.storage.replicate(socket);
      replicationStream.on("error", (error: Error) => {
        this.logger.warn("Replication stream error", {
          remoteDid: remoteHello.agentDid,
          error: error.message
        });
      });
      this.activePeerSessions.set(session.remoteDid, session);
      socket.once("close", () => {
        this.activePeerSessions.delete(session.remoteDid);
        this.logger.info("Peer disconnected", {
          remoteDid: session.remoteDid,
          remoteNoisePublicKey: session.remoteNoisePublicKey
        });
      });
      this.logger.info("Peer connected", {
        source: metadata.source,
        remoteDid: session.remoteDid,
        remoteNoisePublicKey: session.remoteNoisePublicKey,
        replicationCount: session.replication.length
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("Rejected peer connection", {
        source: metadata.source,
        error: message
      });
      socket.destroy(error instanceof Error ? error : undefined);
      if (propagateFailure) {
        throw error;
      }
    }
  }

  private buildLocalHello(): PeerHello {
    return {
      protocolVersion: 1,
      agentDid: this.identity.did,
      capabilities: ["emporion.transport.v1", "hypercore.replicate"],
      supportedProtocols: getSupportedProtocolDescriptors(),
      controlFeedKey: this.identity.controlFeedKey,
      joinedTopics: [...this.joinedTopics.values()].map(({ ref }) => topicRefToCanonicalString(ref)).sort(),
      replication: this.storage.getReplicationDescriptors()
    };
  }

  private async validateRemoteHello(
    socket: NoiseSocket,
    remoteHello: PeerHello,
    source: string
  ): Promise<PeerSession> {
    if (!socket.remotePublicKey) {
      throw new ConnectionRejectedError("Remote socket does not expose a Noise public key");
    }

    const remoteNoisePublicKey = socket.remotePublicKey.toString("hex");
    const resolved = await resolveDidDocument(remoteHello.agentDid);
    const endpoint = extractEmporionTransportService(resolved.didDocument);
    if (endpoint.noisePublicKey !== remoteNoisePublicKey) {
      throw new ConnectionRejectedError(
        `Remote DID ${remoteHello.agentDid} does not match socket key ${remoteNoisePublicKey}`
      );
    }
    if (endpoint.controlFeedKey !== remoteHello.controlFeedKey) {
      throw new ConnectionRejectedError(`Remote DID ${remoteHello.agentDid} advertised a mismatched control feed`);
    }

    return {
      remoteDid: remoteHello.agentDid,
      remoteNoisePublicKey,
      remoteControlFeedKey: remoteHello.controlFeedKey,
      source,
      supportedProtocols: remoteHello.supportedProtocols,
      replication: remoteHello.replication
    };
  }

  private ensureStarted(): void {
    if (!this.started) {
      throw new ConnectionRejectedError("Agent transport must be started before performing network operations");
    }
  }
}
