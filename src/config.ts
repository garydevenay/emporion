import path from "node:path";

import { ConfigValidationError } from "./errors.js";
import type { NormalizedTransportConfig, TransportConfig } from "./types.js";

export function normalizeTransportConfig(config: TransportConfig): NormalizedTransportConfig {
  if (!config.dataDir || config.dataDir.trim().length === 0) {
    throw new ConfigValidationError("TransportConfig.dataDir is required");
  }

  const maxPeers = config.maxPeers ?? 64;
  if (!Number.isInteger(maxPeers) || maxPeers <= 0) {
    throw new ConfigValidationError("TransportConfig.maxPeers must be a positive integer");
  }

  const handshakeTimeoutMs = config.handshakeTimeoutMs ?? 10_000;
  if (!Number.isInteger(handshakeTimeoutMs) || handshakeTimeoutMs <= 0) {
    throw new ConfigValidationError("TransportConfig.handshakeTimeoutMs must be a positive integer");
  }

  const reconnectBackoff = config.reconnectBackoff ?? { minMs: 250, maxMs: 30_000 };
  if (!Number.isInteger(reconnectBackoff.minMs) || reconnectBackoff.minMs <= 0) {
    throw new ConfigValidationError("TransportConfig.reconnectBackoff.minMs must be a positive integer");
  }
  if (!Number.isInteger(reconnectBackoff.maxMs) || reconnectBackoff.maxMs < reconnectBackoff.minMs) {
    throw new ConfigValidationError("TransportConfig.reconnectBackoff.maxMs must be >= minMs");
  }

  if (config.bootstrap !== undefined) {
    if (config.bootstrap.length === 0) {
      throw new ConfigValidationError("TransportConfig.bootstrap must be omitted or contain at least one entry");
    }

    for (const entry of config.bootstrap) {
      if (entry.trim().length === 0) {
        throw new ConfigValidationError("TransportConfig.bootstrap entries must not be blank");
      }
    }
  }

  return {
    dataDir: path.resolve(config.dataDir),
    bootstrap: config.bootstrap,
    maxPeers,
    handshakeTimeoutMs,
    reconnectBackoff,
    logLevel: config.logLevel ?? "info"
  };
}
