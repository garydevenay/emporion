import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { WalletAuthError, WalletUnavailableError } from "../errors.js";
import {
  EMPORION_WALLET_KEY_ENV,
  type WalletConnectionConfig,
  type WalletConnectionMetadata
} from "./types.js";

interface EncryptedSecretEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
}

interface WalletSecretPayload {
  connectionUri: string;
}

const WALLET_RUNTIME_DIR = path.join("runtime", "wallet");
const METADATA_FILE = "connection.metadata.json";
const SECRET_FILE = "connection.secret.enc.json";

function deriveCipherKey(keyMaterial: string): Buffer {
  const trimmed = keyMaterial.trim();
  if (trimmed.length === 0) {
    throw new WalletAuthError(`${EMPORION_WALLET_KEY_ENV} must not be blank`);
  }
  return createHash("sha256").update(trimmed, "utf8").digest();
}

function encryptSecret(payload: WalletSecretPayload, keyMaterial: string): EncryptedSecretEnvelope {
  const iv = randomBytes(12);
  const key = deriveCipherKey(keyMaterial);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    ciphertext: ciphertext.toString("hex")
  };
}

function decryptSecret(envelope: EncryptedSecretEnvelope, keyMaterial: string): WalletSecretPayload {
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
    throw new WalletAuthError("Unsupported wallet secret envelope version");
  }

  try {
    const key = deriveCipherKey(keyMaterial);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "hex"));
    decipher.setAuthTag(Buffer.from(envelope.authTag, "hex"));
    const ciphertext = Buffer.from(envelope.ciphertext, "hex");
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const payload = JSON.parse(decrypted) as Partial<WalletSecretPayload>;
    if (typeof payload.connectionUri !== "string" || payload.connectionUri.trim().length === 0) {
      throw new WalletAuthError("Wallet secret payload is invalid");
    }
    return {
      connectionUri: payload.connectionUri
    };
  } catch (error) {
    if (error instanceof WalletAuthError) {
      throw error;
    }
    throw new WalletAuthError("Failed to decrypt wallet secret. Check EMPORION_WALLET_KEY", { cause: error });
  }
}

function parseConnectionMetadata(value: unknown): WalletConnectionMetadata {
  if (typeof value !== "object" || value === null) {
    throw new WalletUnavailableError("Wallet metadata is invalid");
  }

  const record = value as Record<string, unknown>;
  if (record.backend !== "nwc" && record.backend !== "circle") {
    throw new WalletUnavailableError("Wallet metadata backend is invalid");
  }
  if (record.network !== "bitcoin" && record.network !== "offchain") {
    throw new WalletUnavailableError("Wallet metadata network is invalid");
  }
  if (record.backend === "nwc" && record.network !== "bitcoin") {
    throw new WalletUnavailableError("Wallet metadata network is invalid for nwc backend");
  }
  if (record.backend === "circle" && record.network !== "offchain") {
    throw new WalletUnavailableError("Wallet metadata network is invalid for circle backend");
  }
  if (typeof record.connectedAt !== "string" || record.connectedAt.trim().length === 0) {
    throw new WalletUnavailableError("Wallet metadata connectedAt is invalid");
  }
  if (typeof record.endpoint !== "string" || record.endpoint.trim().length === 0) {
    throw new WalletUnavailableError("Wallet metadata endpoint is invalid");
  }

  return {
    backend: record.backend,
    network: record.network,
    connectedAt: record.connectedAt,
    endpoint: record.endpoint
  };
}

function parseEncryptedSecret(value: unknown): EncryptedSecretEnvelope {
  if (typeof value !== "object" || value === null) {
    throw new WalletUnavailableError("Encrypted wallet secret is invalid");
  }

  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.algorithm !== "aes-256-gcm") {
    throw new WalletUnavailableError("Encrypted wallet secret version is invalid");
  }
  for (const field of ["iv", "authTag", "ciphertext"] as const) {
    if (typeof record[field] !== "string" || (record[field] as string).length === 0) {
      throw new WalletUnavailableError(`Encrypted wallet secret ${field} is invalid`);
    }
  }

  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: record.iv as string,
    authTag: record.authTag as string,
    ciphertext: record.ciphertext as string
  };
}

export function getWalletKeyFromEnv(
  env: NodeJS.ProcessEnv,
  variableName = EMPORION_WALLET_KEY_ENV
): string {
  const key = env[variableName];
  if (!key || key.trim().length === 0) {
    throw new WalletAuthError(
      `Wallet key is required in ${variableName} when encrypted wallet config exists`
    );
  }
  return key;
}

export function getWalletRuntimeDir(dataDir: string): string {
  return path.join(path.resolve(dataDir), WALLET_RUNTIME_DIR);
}

export class WalletConfigStore {
  private readonly metadataPath: string;
  private readonly secretPath: string;

  public constructor(private readonly dataDir: string) {
    const runtimeDir = getWalletRuntimeDir(dataDir);
    this.metadataPath = path.join(runtimeDir, METADATA_FILE);
    this.secretPath = path.join(runtimeDir, SECRET_FILE);
  }

  public async hasEncryptedConfig(): Promise<boolean> {
    const [metadata, secret] = await Promise.all([this.fileExists(this.metadataPath), this.fileExists(this.secretPath)]);
    return metadata || secret;
  }

  public async writeConnection(config: WalletConnectionConfig, keyMaterial: string): Promise<void> {
    const runtimeDir = getWalletRuntimeDir(this.dataDir);
    await mkdir(runtimeDir, { recursive: true });

    const metadata: WalletConnectionMetadata = {
      backend: config.backend,
      network: config.network,
      connectedAt: config.connectedAt,
      endpoint: config.endpoint
    };
    const secret = encryptSecret({ connectionUri: config.connectionUri }, keyMaterial);

    await writeFile(this.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await writeFile(this.secretPath, `${JSON.stringify(secret, null, 2)}\n`, "utf8");
  }

  public async clearConnection(): Promise<void> {
    await Promise.all([rm(this.metadataPath, { force: true }), rm(this.secretPath, { force: true })]);
  }

  public async readMetadata(): Promise<WalletConnectionMetadata | null> {
    if (!(await this.fileExists(this.metadataPath))) {
      return null;
    }

    const content = await readFile(this.metadataPath, "utf8");
    return parseConnectionMetadata(JSON.parse(content));
  }

  public async readConnection(keyMaterial: string): Promise<WalletConnectionConfig | null> {
    const metadata = await this.readMetadata();
    if (!metadata) {
      return null;
    }

    if (!(await this.fileExists(this.secretPath))) {
      throw new WalletUnavailableError("Wallet metadata exists but encrypted wallet secret is missing");
    }
    const encryptedSecret = parseEncryptedSecret(JSON.parse(await readFile(this.secretPath, "utf8")));
    const secret = decryptSecret(encryptedSecret, keyMaterial);
    return {
      ...metadata,
      connectionUri: secret.connectionUri
    };
  }

  public async rotateKey(oldKeyMaterial: string, newKeyMaterial: string): Promise<void> {
    const existing = await this.readConnection(oldKeyMaterial);
    if (!existing) {
      throw new WalletUnavailableError("No wallet connection is configured");
    }
    await this.writeConnection(existing, newKeyMaterial);
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await readFile(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
