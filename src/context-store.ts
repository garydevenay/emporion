import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export const EMPORION_CONTEXTS_FILE_ENV = "EMPORION_CONTEXTS_FILE";

export interface NamedContext {
  name: string;
  dataDir: string;
}

export interface ContextStoreSnapshot {
  activeContext: string | null;
  contexts: NamedContext[];
}

interface ContextFile {
  activeContext: string | null;
  contexts: Record<string, { dataDir: string }>;
}

function normalizeContextName(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error("Context name must match [A-Za-z0-9._-]+");
  }
  return trimmed;
}

function defaultContextStorePath(): string {
  const override = process.env[EMPORION_CONTEXTS_FILE_ENV];
  if (override && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  return path.join(os.homedir(), ".emporion", "contexts.v1.json");
}

function normalizeDataDir(dataDir: string): string {
  const trimmed = dataDir.trim();
  if (trimmed.length === 0) {
    throw new Error("Context data-dir must not be blank");
  }
  return path.resolve(trimmed);
}

function parseContextFile(raw: unknown): ContextFile {
  const value = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const contextsValue = typeof value.contexts === "object" && value.contexts !== null ? value.contexts as Record<string, unknown> : {};
  const contexts: Record<string, { dataDir: string }> = {};
  for (const [name, entry] of Object.entries(contextsValue)) {
    const contextName = normalizeContextName(name);
    const record = typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : {};
    const dataDir = normalizeDataDir(typeof record.dataDir === "string" ? record.dataDir : "");
    contexts[contextName] = { dataDir };
  }
  const activeContext = value.activeContext === null
    ? null
    : typeof value.activeContext === "string" && value.activeContext.trim().length > 0
      ? normalizeContextName(value.activeContext)
      : null;

  if (activeContext && !contexts[activeContext]) {
    return { activeContext: null, contexts };
  }
  return { activeContext, contexts };
}

function toSnapshot(file: ContextFile): ContextStoreSnapshot {
  return {
    activeContext: file.activeContext,
    contexts: Object.entries(file.contexts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]) => ({ name, dataDir: entry.dataDir }))
  };
}

export class ContextStore {
  private readonly filePath: string;
  private loaded = false;
  private data: ContextFile = {
    activeContext: null,
    contexts: {}
  };

  public constructor(filePath = defaultContextStorePath()) {
    this.filePath = path.resolve(filePath);
  }

  public async snapshot(): Promise<ContextStoreSnapshot> {
    await this.ensureLoaded();
    return toSnapshot(this.data);
  }

  public async resolveDataDir(contextName?: string): Promise<string | undefined> {
    await this.ensureLoaded();
    if (contextName && contextName.trim().length > 0) {
      const normalized = normalizeContextName(contextName);
      return this.data.contexts[normalized]?.dataDir;
    }
    const active = this.data.activeContext;
    return active ? this.data.contexts[active]?.dataDir : undefined;
  }

  public async add(name: string, dataDir: string, makeActive: boolean): Promise<ContextStoreSnapshot> {
    await this.ensureLoaded();
    const normalizedName = normalizeContextName(name);
    this.data.contexts[normalizedName] = {
      dataDir: normalizeDataDir(dataDir)
    };
    if (makeActive || this.data.activeContext === null) {
      this.data.activeContext = normalizedName;
    }
    await this.persist();
    return toSnapshot(this.data);
  }

  public async use(name: string): Promise<ContextStoreSnapshot> {
    await this.ensureLoaded();
    const normalizedName = normalizeContextName(name);
    if (!this.data.contexts[normalizedName]) {
      throw new Error(`Unknown context: ${normalizedName}`);
    }
    this.data.activeContext = normalizedName;
    await this.persist();
    return toSnapshot(this.data);
  }

  public async remove(name: string): Promise<ContextStoreSnapshot> {
    await this.ensureLoaded();
    const normalizedName = normalizeContextName(name);
    if (!this.data.contexts[normalizedName]) {
      throw new Error(`Unknown context: ${normalizedName}`);
    }
    delete this.data.contexts[normalizedName];
    if (this.data.activeContext === normalizedName) {
      this.data.activeContext = null;
    }
    await this.persist();
    return toSnapshot(this.data);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const content = await readFile(this.filePath, "utf8");
      this.data = parseContextFile(JSON.parse(content) as unknown);
    } catch {
      this.data = {
        activeContext: null,
        contexts: {}
      };
    }
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
  }
}

