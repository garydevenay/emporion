import { mkdir } from "node:fs/promises";

import { readPersistedAgentIdentity, loadIdentityMaterial, persistAgentIdentity, type IdentityMaterial } from "./identity.js";
import { createLogger } from "./logger.js";
import { TransportStorage } from "./storage.js";

const PROVISIONAL_CONTROL_FEED_KEY = "0".repeat(64);

export async function loadPersistentIdentityMaterial(dataDir: string): Promise<IdentityMaterial> {
  await mkdir(dataDir, { recursive: true });

  const persistedIdentity = await readPersistedAgentIdentity(dataDir);
  if (persistedIdentity) {
    return loadIdentityMaterial(dataDir, persistedIdentity.controlFeedKey);
  }

  const provisionalIdentity = await loadIdentityMaterial(dataDir, PROVISIONAL_CONTROL_FEED_KEY);
  const storage = await TransportStorage.create(dataDir, provisionalIdentity.storagePrimaryKey, createLogger("error"));

  try {
    const defaults = await storage.initializeDefaults();
    const resolvedIdentity = await loadIdentityMaterial(dataDir, defaults.controlDescriptor.key);
    await persistAgentIdentity(dataDir, resolvedIdentity.agentIdentity);
    return resolvedIdentity;
  } finally {
    await storage.close();
  }
}
