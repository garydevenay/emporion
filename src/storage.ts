import { mkdir } from "node:fs/promises";
import path from "node:path";

import Corestore from "corestore";
import Hyperbee from "hyperbee";
import Hypercore from "hypercore";

import { StorageError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { ReplicationDescriptor } from "./types.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface NamedFeedRecord {
  descriptor: ReplicationDescriptor;
  core: Hypercore<JsonValue>;
}

interface NamedIndexRecord {
  descriptor: ReplicationDescriptor;
  bee: Hyperbee<string, JsonValue>;
}

interface DownloadHandle {
  destroy(): void;
}

interface RemoteFeedRecord {
  core: Hypercore<JsonValue>;
  liveDownload: DownloadHandle;
}

interface RemoteIndexRecord {
  bee: Hyperbee<string, JsonValue>;
  liveDownload: DownloadHandle;
}

function isNonEmptyString(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new StorageError(`${fieldName} must not be blank`);
  }

  return trimmed;
}

export class TransportStorage {
  private readonly store: Corestore;
  private readonly logger: Logger;
  private readonly feedNamespace: Corestore;
  private readonly indexNamespace: Corestore;
  private readonly localDescriptors = new Map<string, ReplicationDescriptor>();
  private readonly feeds = new Map<string, NamedFeedRecord>();
  private readonly indexes = new Map<string, NamedIndexRecord>();
  private readonly remoteFeeds = new Map<string, RemoteFeedRecord>();
  private readonly remoteIndexes = new Map<string, RemoteIndexRecord>();

  private constructor(store: Corestore, logger: Logger) {
    this.store = store;
    this.logger = logger;
    this.feedNamespace = store.namespace("feeds");
    this.indexNamespace = store.namespace("indexes");
  }

  public static async create(dataDir: string, primaryKey: Buffer, logger: Logger): Promise<TransportStorage> {
    const storageDir = path.join(dataDir, "store");
    await mkdir(storageDir, { recursive: true });
    // We intentionally derive the store primary key from the persisted agent root seed
    // so named cores remain stable across restarts.
    const store = new Corestore(storageDir, { primaryKey, unsafe: true });
    await store.ready();
    return new TransportStorage(store, logger);
  }

  public async initializeDefaults(): Promise<{
    controlFeed: Hypercore<JsonValue>;
    eventsFeed: Hypercore<JsonValue>;
    controlDescriptor: ReplicationDescriptor;
    eventsDescriptor: ReplicationDescriptor;
  }> {
    const controlFeed = await this.openFeed("control");
    const eventsFeed = await this.openFeed("events");

    return {
      controlFeed,
      eventsFeed,
      controlDescriptor: this.mustGetLocalDescriptor("control"),
      eventsDescriptor: this.mustGetLocalDescriptor("events")
    };
  }

  public async openFeed(name: string): Promise<Hypercore<JsonValue>> {
    const normalizedName = isNonEmptyString(name, "Feed name");
    const existing = this.feeds.get(normalizedName);
    if (existing) {
      return existing.core;
    }

    const core = this.feedNamespace.get({
      name: normalizedName,
      valueEncoding: "json"
    }) as Hypercore<JsonValue>;
    await core.ready();
    const descriptor: ReplicationDescriptor = {
      name: normalizedName,
      key: core.key.toString("hex"),
      kind: "feed"
    };
    this.localDescriptors.set(normalizedName, descriptor);
    this.feeds.set(normalizedName, { core, descriptor });
    this.logger.debug("Opened local feed", { ...descriptor });
    return core;
  }

  public async openIndex(name: string): Promise<Hyperbee<string, JsonValue>> {
    const normalizedName = isNonEmptyString(name, "Index name");
    const existing = this.indexes.get(normalizedName);
    if (existing) {
      return existing.bee;
    }

    const core = this.indexNamespace.get({
      name: normalizedName
    }) as Hypercore<Buffer>;
    await core.ready();
    const bee = new Hyperbee<string, JsonValue>(core, {
      keyEncoding: "utf-8",
      valueEncoding: "json"
    });
    await bee.ready();

    const descriptor: ReplicationDescriptor = {
      name: normalizedName,
      key: core.key.toString("hex"),
      kind: "index"
    };
    this.localDescriptors.set(normalizedName, descriptor);
    this.indexes.set(normalizedName, { bee, descriptor });
    this.logger.debug("Opened local index", { ...descriptor });
    return bee;
  }

  public getReplicationDescriptors(): ReplicationDescriptor[] {
    return [...this.localDescriptors.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  public getLocalFeedKey(name: string): string {
    return this.mustGetLocalDescriptor(name).key;
  }

  public async trackRemoteDescriptors(descriptors: ReplicationDescriptor[]): Promise<void> {
    for (const descriptor of descriptors) {
      if (descriptor.kind === "feed") {
        if (this.remoteFeeds.has(descriptor.key)) {
          continue;
        }

        const core = this.store.get({
          key: Buffer.from(descriptor.key, "hex"),
          valueEncoding: "json"
        }) as Hypercore<JsonValue>;
        await core.ready();
        const liveDownload = core.download({ start: 0, end: -1, linear: true });
        this.remoteFeeds.set(descriptor.key, { core, liveDownload });
        this.logger.debug("Tracked remote feed", { ...descriptor });
        continue;
      }

      if (this.remoteIndexes.has(descriptor.key)) {
        continue;
      }

      const core = this.store.get({
        key: Buffer.from(descriptor.key, "hex")
      }) as Hypercore<Buffer>;
      await core.ready();
      const bee = new Hyperbee<string, JsonValue>(core, {
        keyEncoding: "utf-8",
        valueEncoding: "json"
      });
      await bee.ready();
      const liveDownload = core.download({ start: 0, end: -1, linear: true });
      this.remoteIndexes.set(descriptor.key, { bee, liveDownload });
      this.logger.debug("Tracked remote index", { ...descriptor });
    }
  }

  public getRemoteFeed(key: string): Hypercore<JsonValue> | undefined {
    return this.remoteFeeds.get(key)?.core;
  }

  public replicate(connection: NodeJS.ReadWriteStream): NodeJS.ReadWriteStream {
    return this.store.replicate(connection);
  }

  public async close(): Promise<void> {
    for (const record of this.remoteFeeds.values()) {
      record.liveDownload.destroy();
    }
    for (const record of this.remoteIndexes.values()) {
      record.liveDownload.destroy();
    }
    await this.store.close();
  }

  private mustGetLocalDescriptor(name: string): ReplicationDescriptor {
    const descriptor = this.localDescriptors.get(name);
    if (!descriptor) {
      throw new StorageError(`Local descriptor not found for ${name}`);
    }

    return descriptor;
  }
}
