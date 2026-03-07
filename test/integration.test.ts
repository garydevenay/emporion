import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import DHT from "hyperdht";

import { performPeerHandshake } from "../src/handshake.js";
import type { NoiseSocket } from "../src/handshake.js";
import { loadIdentityMaterial } from "../src/identity.js";
import { getSupportedProtocolDescriptors } from "../src/protocol/index.js";
import { AgentTransport } from "../src/transport.js";
import type { PeerHello } from "../src/types.js";
import { createBootstrapNode, removeTempDir, waitFor } from "./helpers.js";

async function createAgentDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("two agents discover each other, complete the handshake, and replicate the events feed", async () => {
  const bootstrap = await createBootstrapNode();
  const dirA = await createAgentDir("emporion-agent-a-");
  const dirB = await createAgentDir("emporion-agent-b-");

  const agentA = await AgentTransport.create({
    dataDir: dirA,
    bootstrap: bootstrap.bootstrap,
    logLevel: "error",
    handshakeTimeoutMs: 2_000
  });
  const agentB = await AgentTransport.create({
    dataDir: dirB,
    bootstrap: bootstrap.bootstrap,
    logLevel: "error",
    handshakeTimeoutMs: 2_000
  });

  try {
    await Promise.all([agentA.start(), agentB.start()]);
    await agentA.joinTopic({ kind: "marketplace", marketplaceId: "coding" });
    await agentB.joinTopic({ kind: "marketplace", marketplaceId: "coding" });

    await waitFor(() => agentA.getPeerSessions().size > 0 && agentB.getPeerSessions().size > 0, {
      timeoutMs: 10_000,
      message: "Agents did not connect through Hyperswarm"
    });

    const eventsFeedA = await agentA.openFeed("events");
    await eventsFeedA.append({
      type: "offer",
      payload: "hello-market",
      createdAt: new Date().toISOString()
    });

    const feedKey = eventsFeedA.key.toString("hex");
    const remoteEventsDescriptorOnB = [...agentB.getPeerSessions().values()][0]?.replication.find(
      (descriptor) => descriptor.name === "events"
    );
    assert.ok(remoteEventsDescriptorOnB);
    assert.equal(remoteEventsDescriptorOnB.key, feedKey);
    const remoteFeed = await waitFor(async () => {
      const feed = agentB.getRemoteFeed(remoteEventsDescriptorOnB.key) ?? null;
      if (!feed) {
        return null;
      }

      await feed.update({ wait: false });
      return feed.length >= 1 ? feed : null;
    }, {
      timeoutMs: 10_000,
      message: "Remote events feed was not tracked"
    });
    assert.ok(remoteFeed);
    const replicated = await remoteFeed.get(0, { timeout: 5_000 });
    assert.ok(replicated && typeof replicated === "object" && !Array.isArray(replicated));
    const replicatedRecord = replicated as Record<string, unknown>;

    assert.deepEqual(replicatedRecord, {
      type: "offer",
      payload: "hello-market",
      createdAt: replicatedRecord.createdAt
    });
    assert.equal(typeof replicatedRecord.createdAt, "string");

    const eventsFeedB = await agentB.openFeed("events");
    await eventsFeedB.append({
      type: "bid",
      payload: "reply-from-b",
      createdAt: new Date().toISOString()
    });

    const remoteEventsDescriptorOnA = [...agentA.getPeerSessions().values()][0]?.replication.find(
      (descriptor) => descriptor.name === "events"
    );
    assert.ok(remoteEventsDescriptorOnA);
    const remoteFeedOnA = await waitFor(async () => {
      const feed = agentA.getRemoteFeed(remoteEventsDescriptorOnA.key) ?? null;
      if (!feed) {
        return null;
      }

      await feed.update({ wait: false });
      return feed.length >= 1 ? feed : null;
    }, {
      timeoutMs: 10_000,
      message: "Peer A did not observe the later append from peer B"
    });
    assert.ok(remoteFeedOnA);
    const replicatedReply = await remoteFeedOnA.get(0, { timeout: 5_000 });
    assert.ok(replicatedReply && typeof replicatedReply === "object" && !Array.isArray(replicatedReply));
    const replicatedReplyRecord = replicatedReply as Record<string, unknown>;
    assert.equal(replicatedReplyRecord.type, "bid");
    assert.equal(replicatedReplyRecord.payload, "reply-from-b");
  } finally {
    await Promise.allSettled([agentA.stop(), agentB.stop()]);
    await Promise.allSettled([removeTempDir(dirA), removeTempDir(dirB), bootstrap.destroy()]);
  }
});

test("connectToDid uses the DID document transport endpoint on an isolated bootstrap node", async () => {
  const bootstrap = await createBootstrapNode();
  const dirA = await createAgentDir("emporion-did-a-");
  const dirB = await createAgentDir("emporion-did-b-");

  const agentA = await AgentTransport.create({
    dataDir: dirA,
    bootstrap: bootstrap.bootstrap,
    logLevel: "error",
    handshakeTimeoutMs: 2_000
  });
  const agentB = await AgentTransport.create({
    dataDir: dirB,
    bootstrap: bootstrap.bootstrap,
    logLevel: "error",
    handshakeTimeoutMs: 2_000
  });

  try {
    await Promise.all([agentA.start(), agentB.start()]);
    await agentB.connectToDid(agentA.identity.did);

    await waitFor(() => agentA.getPeerSessions().size > 0 && agentB.getPeerSessions().size > 0, {
      timeoutMs: 10_000,
      message: "Agents did not connect through direct DID dialing"
    });
  } finally {
    await Promise.allSettled([agentA.stop(), agentB.stop()]);
    await Promise.allSettled([removeTempDir(dirA), removeTempDir(dirB), bootstrap.destroy()]);
  }
});

test("invalid topic identifiers are rejected before joining the swarm", async () => {
  const bootstrap = await createBootstrapNode();
  const dir = await createAgentDir("emporion-invalid-topic-");
  const agent = await AgentTransport.create({
    dataDir: dir,
    bootstrap: bootstrap.bootstrap,
    logLevel: "error"
  });

  try {
    await agent.start();
    await assert.rejects(
      () => agent.joinTopic({ kind: "marketplace", marketplaceId: "bad topic" }),
      /unsupported characters/i
    );
  } finally {
    await Promise.allSettled([agent.stop(), removeTempDir(dir), bootstrap.destroy()]);
  }
});

test("a direct connection is rejected when the DID document transport key does not match the socket key", async () => {
  const bootstrap = await createBootstrapNode();
  const honestDir = await createAgentDir("emporion-honest-");
  const callerDir = await createAgentDir("emporion-caller-");
  const maliciousDir = await createAgentDir("emporion-malicious-");

  const honestIdentity = await loadIdentityMaterial(honestDir, "aa".repeat(32));
  const maliciousIdentity = await loadIdentityMaterial(maliciousDir, "bb".repeat(32));
  const caller = await AgentTransport.create({
    dataDir: callerDir,
    bootstrap: bootstrap.bootstrap,
    logLevel: "error",
    handshakeTimeoutMs: 300
  });

  const maliciousDht = new DHT({
    bootstrap: bootstrap.bootstrap,
    keyPair: maliciousIdentity.transportKeyPair
  });
  const server = maliciousDht.createServer(async (socket: NoiseSocket) => {
    socket.on("error", () => {
      // The client intentionally tears down the connection after rejecting the DID binding.
    });

    const hello: PeerHello = {
      protocolVersion: 1,
      agentDid: honestIdentity.agentIdentity.did,
      capabilities: ["emporion.transport.v1"],
      supportedProtocols: getSupportedProtocolDescriptors(),
      controlFeedKey: honestIdentity.agentIdentity.controlFeedKey,
      joinedTopics: [],
      replication: []
    };

    try {
      await performPeerHandshake(socket, hello, 2_000);
    } catch {
      socket.destroy();
    }
  });

  try {
    await caller.start();
    await server.listen(maliciousIdentity.transportKeyPair);

    await assert.rejects(
      () => caller.connectToNoiseKey(maliciousIdentity.agentIdentity.noisePublicKey),
      /does not match socket key/i
    );
  } finally {
    await Promise.allSettled([
      caller.stop(),
      server.close(),
      maliciousDht.destroy(),
      removeTempDir(honestDir),
      removeTempDir(callerDir),
      removeTempDir(maliciousDir),
      bootstrap.destroy()
    ]);
  }
});

test("direct connections time out if the remote peer never completes the handshake", async () => {
  const bootstrap = await createBootstrapNode();
  const serverDir = await createAgentDir("emporion-timeout-server-");
  const callerDir = await createAgentDir("emporion-timeout-caller-");

  const serverIdentity = await loadIdentityMaterial(serverDir, "cc".repeat(32));
  const caller = await AgentTransport.create({
    dataDir: callerDir,
    bootstrap: bootstrap.bootstrap,
    logLevel: "error",
    handshakeTimeoutMs: 200
  });

  const hangingDht = new DHT({
    bootstrap: bootstrap.bootstrap,
    keyPair: serverIdentity.transportKeyPair
  });
  const server = hangingDht.createServer((socket: NoiseSocket) => {
    socket.on("error", () => {
      // The client intentionally tears down the connection after timing out the handshake.
    });

    // Intentionally never writes a hello.
  });

  try {
    await caller.start();
    await server.listen(serverIdentity.transportKeyPair);

    await assert.rejects(
      () => caller.connectToNoiseKey(serverIdentity.agentIdentity.noisePublicKey),
      /handshake timed out/i
    );
  } finally {
    await Promise.allSettled([
      caller.stop(),
      server.close(),
      hangingDht.destroy(),
      removeTempDir(serverDir),
      removeTempDir(callerDir),
      bootstrap.destroy()
    ]);
  }
});

test("agent identity persists across restarts and stop() is clean and idempotent", async () => {
  const bootstrap = await createBootstrapNode();
  const dir = await createAgentDir("emporion-restart-");

  const first = await AgentTransport.create({
    dataDir: dir,
    bootstrap: bootstrap.bootstrap,
    logLevel: "error"
  });

  const firstDid = first.identity.did;

  try {
    await first.start();
  } finally {
    await first.stop();
    await first.stop();
  }

  const second = await AgentTransport.create({
    dataDir: dir,
    bootstrap: bootstrap.bootstrap,
    logLevel: "error"
  });

  try {
    assert.equal(second.identity.did, firstDid);
    await second.start();
  } finally {
    await Promise.allSettled([second.stop(), rm(dir, { recursive: true, force: true }), bootstrap.destroy()]);
  }
});
