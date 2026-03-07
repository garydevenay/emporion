import { duplexPair } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTransportConfig } from "../src/config.js";
import { createPeerDid, extractEmporionTransportService, resolveDidDocument } from "../src/did.js";
import { loadIdentityMaterial } from "../src/identity.js";
import { performPeerHandshake } from "../src/handshake.js";
import { topicRefToCanonicalString, topicRefToDiscoveryKey } from "../src/topics.js";
import type { PeerHello } from "../src/types.js";
import { createTempDir, removeTempDir } from "./helpers.js";

test("normalizeTransportConfig applies defaults and validates boundaries", () => {
  const normalized = normalizeTransportConfig({
    dataDir: "./tmp/agent"
  });

  assert.equal(normalized.maxPeers, 64);
  assert.equal(normalized.handshakeTimeoutMs, 10_000);
  assert.equal(normalized.reconnectBackoff.minMs, 250);
  assert.equal(normalized.reconnectBackoff.maxMs, 30_000);
});

test("topic helpers are deterministic and canonical", () => {
  const ref = { kind: "marketplace", marketplaceId: "coding" } as const;
  assert.equal(topicRefToCanonicalString(ref), "marketplace:coding");
  assert.deepEqual(topicRefToDiscoveryKey(ref), topicRefToDiscoveryKey(ref));
});

test("identity persistence keeps transport keys and DID stable across restarts", async () => {
  const tempDir = await createTempDir("emporion-identity-");

  try {
    const first = await loadIdentityMaterial(tempDir, "ab".repeat(32));
    const second = await loadIdentityMaterial(tempDir, "ab".repeat(32));

    assert.equal(first.agentIdentity.noisePublicKey, second.agentIdentity.noisePublicKey);
    assert.equal(first.agentIdentity.did, second.agentIdentity.did);
  } finally {
    await removeTempDir(tempDir);
  }
});

test("did:peer documents resolve and expose the Emporion transport service", async () => {
  const noiseKey = "11".repeat(32);
  const keyAgreementKey = "33".repeat(32);
  const controlFeedKey = "22".repeat(32);

  const { did } = createPeerDid(noiseKey, keyAgreementKey, controlFeedKey);
  const resolved = await resolveDidDocument(did);
  const endpoint = extractEmporionTransportService(resolved.didDocument);

  assert.equal(endpoint.noisePublicKey, noiseKey);
  assert.equal(endpoint.controlFeedKey, controlFeedKey);
});

test("performPeerHandshake exchanges and validates framed hello payloads", async () => {
  const [left, right] = duplexPair();
  const leftHello: PeerHello = {
    protocolVersion: 1,
    agentDid: "did:peer:2.left",
    capabilities: ["left"],
    controlFeedKey: "11".repeat(32),
    joinedTopics: ["marketplace:coding"],
    replication: []
  };
  const rightHello: PeerHello = {
    protocolVersion: 1,
    agentDid: "did:peer:2.right",
    capabilities: ["right"],
    controlFeedKey: "22".repeat(32),
    joinedTopics: ["company:emporion"],
    replication: []
  };

  const [receivedByLeft, receivedByRight] = await Promise.all([
    performPeerHandshake(left, leftHello, 2_000),
    performPeerHandshake(right, rightHello, 2_000)
  ]);

  assert.equal(receivedByLeft.agentDid, rightHello.agentDid);
  assert.equal(receivedByRight.agentDid, leftHello.agentDid);
});

test("performPeerHandshake times out when the remote peer stays silent", async () => {
  const [left] = duplexPair();
  const hello: PeerHello = {
    protocolVersion: 1,
    agentDid: "did:peer:2.left",
    capabilities: ["left"],
    controlFeedKey: "11".repeat(32),
    joinedTopics: [],
    replication: []
  };

  await assert.rejects(() => performPeerHandshake(left, hello, 50), /timed out/i);
});
