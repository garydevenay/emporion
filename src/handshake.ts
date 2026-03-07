import { Buffer } from "node:buffer";
import { once } from "node:events";
import type { Duplex } from "node:stream";

import { HandshakeError } from "./errors.js";
import type { SupportedProtocolDescriptor } from "./protocol/versioning.js";
import type { PeerHello, ReplicationDescriptor } from "./types.js";

export interface NoiseSocket extends Duplex {
  remotePublicKey?: Buffer;
  publicKey?: Buffer;
}

function isValidReplicationDescriptor(value: unknown): value is ReplicationDescriptor {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    /^[a-f0-9]{64}$/i.test(String(record.key)) &&
    (record.kind === "feed" || record.kind === "index")
  );
}

function isValidSupportedProtocolDescriptor(value: unknown): value is SupportedProtocolDescriptor {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.protocol === "string" &&
    Array.isArray(record.supportedMajorVersions) &&
    record.supportedMajorVersions.every((entry) => Number.isInteger(entry) && Number(entry) > 0) &&
    typeof record.latestVersion === "string"
  );
}

export function validatePeerHello(value: unknown): PeerHello {
  if (typeof value !== "object" || value === null) {
    throw new HandshakeError("PeerHello must be an object");
  }

  const record = value as Record<string, unknown>;
  if (record.protocolVersion !== 1) {
    throw new HandshakeError("PeerHello.protocolVersion must be 1");
  }
  if (typeof record.agentDid !== "string" || record.agentDid.length === 0) {
    throw new HandshakeError("PeerHello.agentDid must be a non-empty string");
  }
  if (typeof record.controlFeedKey !== "string" || !/^[a-f0-9]{64}$/i.test(record.controlFeedKey)) {
    throw new HandshakeError("PeerHello.controlFeedKey must be a 32-byte hex string");
  }
  if (!Array.isArray(record.capabilities) || record.capabilities.some((entry) => typeof entry !== "string")) {
    throw new HandshakeError("PeerHello.capabilities must be an array of strings");
  }
  if (
    record.supportedProtocols !== undefined &&
    (!Array.isArray(record.supportedProtocols) ||
      record.supportedProtocols.some((entry) => !isValidSupportedProtocolDescriptor(entry)))
  ) {
    throw new HandshakeError("PeerHello.supportedProtocols must be an array of supported protocol descriptors");
  }
  if (!Array.isArray(record.joinedTopics) || record.joinedTopics.some((entry) => typeof entry !== "string")) {
    throw new HandshakeError("PeerHello.joinedTopics must be an array of strings");
  }
  if (!Array.isArray(record.replication) || record.replication.some((entry) => !isValidReplicationDescriptor(entry))) {
    throw new HandshakeError("PeerHello.replication must be an array of replication descriptors");
  }

  return {
    protocolVersion: 1,
    agentDid: record.agentDid,
    controlFeedKey: record.controlFeedKey,
    capabilities: [...record.capabilities],
    supportedProtocols: [...((record.supportedProtocols as SupportedProtocolDescriptor[] | undefined) ?? [])],
    joinedTopics: [...record.joinedTopics],
    replication: [...record.replication]
  };
}

async function writeFrame(socket: NoiseSocket, payload: PeerHello): Promise<void> {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.byteLength, 0);

  if (!socket.write(header)) {
    await once(socket, "drain");
  }

  if (!socket.write(body)) {
    await once(socket, "drain");
  }
}

function remainingTimeoutMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function readExactBytes(socket: NoiseSocket, byteLength: number, deadline: number): Promise<Buffer> {
  if (byteLength <= 0) {
    return Buffer.alloc(0);
  }

  const chunks: Buffer[] = [];
  let remaining = byteLength;

  while (remaining > 0) {
    const chunk = socket.read(remaining) as Buffer | null;
    if (chunk && chunk.byteLength > 0) {
      chunks.push(chunk);
      remaining -= chunk.byteLength;
      continue;
    }

    if (socket.destroyed || socket.readableEnded) {
      throw new HandshakeError("Peer closed the connection before completing the handshake");
    }

    const waitMs = remainingTimeoutMs(deadline);
    if (waitMs === 0) {
      throw new HandshakeError("Peer handshake timed out while waiting for frame bytes");
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new HandshakeError("Peer handshake timed out while waiting for frame bytes"));
      }, waitMs);

      function cleanup(): void {
        clearTimeout(timer);
        socket.off("readable", onReadable);
        socket.off("error", onError);
        socket.off("close", onClose);
        socket.off("end", onClose);
      }

      function onReadable(): void {
        cleanup();
        resolve();
      }

      function onError(error: Error): void {
        cleanup();
        reject(new HandshakeError("Peer handshake failed while reading remote hello", { cause: error }));
      }

      function onClose(): void {
        cleanup();
        reject(new HandshakeError("Peer closed the connection before completing the handshake"));
      }

      socket.once("readable", onReadable);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.once("end", onClose);
    });
  }

  if (chunks.length === 1) {
    const [singleChunk] = chunks;
    if (singleChunk) {
      return singleChunk;
    }
  }

  return Buffer.concat(chunks, byteLength);
}

async function readFrame(socket: NoiseSocket, timeoutMs: number): Promise<PeerHello> {
  const deadline = Date.now() + timeoutMs;
  const header = await readExactBytes(socket, 4, deadline);
  const bodyLength = header.readUInt32BE(0);
  const maxFrameBytes = 256 * 1024;

  if (bodyLength === 0 || bodyLength > maxFrameBytes) {
    throw new HandshakeError(`Peer hello frame length must be between 1 and ${maxFrameBytes} bytes`);
  }

  const payload = await readExactBytes(socket, bodyLength, deadline);

  try {
    const parsed = JSON.parse(payload.toString("utf8")) as unknown;
    return validatePeerHello(parsed);
  } catch (error) {
    throw new HandshakeError("Peer sent an invalid hello payload", { cause: error });
  }
}

export async function performPeerHandshake(
  socket: NoiseSocket,
  localHello: PeerHello,
  timeoutMs: number
): Promise<PeerHello> {
  const remoteHelloPromise = readFrame(socket, timeoutMs);
  await writeFrame(socket, localHello);
  return remoteHelloPromise;
}
