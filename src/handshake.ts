import { Buffer } from "node:buffer";
import { once } from "node:events";
import type { Duplex } from "node:stream";

import { HandshakeError } from "./errors.js";
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

async function readFrame(socket: NoiseSocket, timeoutMs: number): Promise<PeerHello> {
  let header: Buffer | undefined;
  let bodyLength = 0;
  let body = Buffer.alloc(0);

  return new Promise<PeerHello>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new HandshakeError(`Peer handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.off("end", onClose);
    }

    function onError(error: Error): void {
      cleanup();
      reject(new HandshakeError("Peer handshake failed while reading remote hello", { cause: error }));
    }

    function onClose(): void {
      cleanup();
      reject(new HandshakeError("Peer closed the connection before completing the handshake"));
    }

    function onData(chunk: Buffer): void {
      body = Buffer.concat([body, chunk]);

      if (!header && body.byteLength >= 4) {
        header = body.subarray(0, 4);
        bodyLength = header.readUInt32BE(0);
        body = body.subarray(4);
      }

      if (!header || body.byteLength < bodyLength) {
        return;
      }

      const payload = body.subarray(0, bodyLength);
      const remainder = body.subarray(bodyLength);
      cleanup();

      if (remainder.byteLength > 0) {
        socket.unshift(remainder);
      }

      try {
        const parsed = JSON.parse(payload.toString("utf8")) as unknown;
        resolve(validatePeerHello(parsed));
      } catch (error) {
        reject(new HandshakeError("Peer sent an invalid hello payload", { cause: error }));
      }
    }

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once("end", onClose);
  });
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
