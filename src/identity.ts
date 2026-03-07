import { hkdfSync, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import DHT from "hyperdht";
import nacl from "tweetnacl";

import { createPeerDid } from "./did.js";
import { IdentityError } from "./errors.js";
import type { AgentIdentity } from "./types.js";

const ROOT_SEED_FILE = "root-seed.bin";
const AGENT_IDENTITY_FILE = "agent-identity.json";
const IDENTITY_SALT = Buffer.from("emporion-agent-root", "utf8");

export interface IdentityMaterial {
  agentIdentity: AgentIdentity;
  transportKeyPair: {
    publicKey: Buffer;
    secretKey: Buffer;
  };
  keyAgreementKeyPair: {
    publicKey: Buffer;
    secretKey: Buffer;
  };
  storagePrimaryKey: Buffer;
  rootSeed: Buffer;
}

async function loadOrCreateRootSeed(identityDir: string): Promise<Buffer> {
  const seedPath = path.join(identityDir, ROOT_SEED_FILE);

  try {
    const existing = await readFile(seedPath);
    if (existing.byteLength !== 32) {
      throw new IdentityError(`Identity root seed at ${seedPath} is invalid`);
    }
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const rootSeed = randomBytes(32);
  await mkdir(identityDir, { recursive: true });
  await writeFile(seedPath, rootSeed, { mode: 0o600 });
  return rootSeed;
}

function identityMetadataPath(dataDir: string): string {
  return path.join(dataDir, "identity", AGENT_IDENTITY_FILE);
}

function isAgentIdentity(value: unknown): value is AgentIdentity {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<AgentIdentity>;
  return (
    typeof candidate.did === "string" &&
    typeof candidate.noisePublicKey === "string" &&
    typeof candidate.keyAgreementPublicKey === "string" &&
    typeof candidate.controlFeedKey === "string" &&
    typeof candidate.didDocument === "object" &&
    candidate.didDocument !== null
  );
}

function deriveBytes(rootSeed: Buffer, context: string): Buffer {
  return Buffer.from(hkdfSync("sha256", rootSeed, IDENTITY_SALT, Buffer.from(context, "utf8"), 32));
}

export async function loadIdentityMaterial(dataDir: string, controlFeedKey: string): Promise<IdentityMaterial> {
  const identityDir = path.join(dataDir, "identity");
  const rootSeed = await loadOrCreateRootSeed(identityDir);
  const transportSeed = deriveBytes(rootSeed, "transport-noise");
  const keyAgreementSeed = deriveBytes(rootSeed, "message-key-agreement");
  const storagePrimaryKey = deriveBytes(rootSeed, "storage-primary");
  const transportKeyPair = DHT.keyPair(transportSeed);
  if (!transportKeyPair.publicKey || !transportKeyPair.secretKey) {
    throw new IdentityError("Failed to derive transport key pair");
  }
  const keyAgreementKeyPair = nacl.box.keyPair.fromSecretKey(new Uint8Array(keyAgreementSeed));

  const noisePublicKey = transportKeyPair.publicKey.toString("hex");
  const keyAgreementPublicKey = Buffer.from(keyAgreementKeyPair.publicKey).toString("hex");
  const { did, didDocument } = createPeerDid(noisePublicKey, keyAgreementPublicKey, controlFeedKey);

  return {
    rootSeed,
    storagePrimaryKey,
    transportKeyPair: {
      publicKey: transportKeyPair.publicKey,
      secretKey: transportKeyPair.secretKey
    },
    keyAgreementKeyPair: {
      publicKey: Buffer.from(keyAgreementKeyPair.publicKey),
      secretKey: Buffer.from(keyAgreementKeyPair.secretKey)
    },
    agentIdentity: {
      did,
      didDocument,
      noisePublicKey,
      keyAgreementPublicKey,
      controlFeedKey
    }
  };
}

export async function persistAgentIdentity(dataDir: string, agentIdentity: AgentIdentity): Promise<void> {
  const identityDir = path.join(dataDir, "identity");
  await mkdir(identityDir, { recursive: true });
  await writeFile(identityMetadataPath(dataDir), JSON.stringify(agentIdentity, null, 2), {
    mode: 0o600
  });
}

export async function readPersistedAgentIdentity(dataDir: string): Promise<AgentIdentity | null> {
  try {
    const raw = await readFile(identityMetadataPath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isAgentIdentity(parsed)) {
      throw new IdentityError(`Persisted agent identity at ${identityMetadataPath(dataDir)} is invalid`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
