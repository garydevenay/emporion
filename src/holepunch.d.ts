declare module "hyperdht" {
  import { Duplex } from "node:stream";

  interface KeyPair {
    publicKey: Buffer;
    secretKey: Buffer;
  }

  interface DhtOptions {
    bootstrap?: string[] | undefined;
    keyPair?: KeyPair;
  }

  interface DhtConnectOptions {
    keyPair?: KeyPair;
  }

  interface DhtDestroyOptions {
    force?: boolean;
  }

  interface DhtServer {
    listen(keyPair: KeyPair): Promise<void>;
    close(): Promise<void>;
    suspend(options?: { log?: (message: string) => void }): Promise<void>;
    resume(): Promise<void>;
    on(event: "connection", listener: (socket: Duplex) => void): this;
  }

  interface BootstrapperAddress {
    host: string;
    port: number;
  }

  interface BootstrapperNode {
    ready(): Promise<void>;
    address(): BootstrapperAddress;
    destroy(): Promise<void>;
  }

  export default class HyperDHT {
    constructor(options?: DhtOptions);
    static keyPair(seed?: Buffer): KeyPair;
    static bootstrapper(port?: number, host?: string, options?: DhtOptions): BootstrapperNode;
    connect(remotePublicKey: Buffer | string, options?: DhtConnectOptions): Duplex & {
      remotePublicKey?: Buffer;
      publicKey?: Buffer;
    };
    createServer(options?: object, onconnection?: (socket: Duplex) => void): DhtServer;
    destroy(options?: DhtDestroyOptions): Promise<void>;
    suspend(options?: { log?: (message: string) => void }): Promise<void>;
    resume(options?: { log?: (message: string) => void }): Promise<void>;
  }
}

declare module "hyperswarm" {
  import { EventEmitter } from "node:events";
  import { Duplex } from "node:stream";
  import HyperDHT from "hyperdht";

  interface KeyPair {
    publicKey: Buffer;
    secretKey: Buffer;
  }

  interface HyperswarmOptions {
    keyPair?: KeyPair;
    maxPeers?: number;
    dht?: HyperDHT;
  }

  interface PeerInfo {
    publicKey: Buffer;
    topics?: Buffer[];
  }

  interface PeerDiscovery {
    flushed(): Promise<void>;
    destroy(): Promise<void>;
  }

  export default class Hyperswarm extends EventEmitter {
    constructor(options?: HyperswarmOptions);
    connecting: number;
    connections: Set<Duplex>;
    dht: HyperDHT;
    join(topic: Buffer, options?: { server?: boolean; client?: boolean; limit?: number }): PeerDiscovery;
    flush(): Promise<void>;
    listen(): Promise<void>;
    leave(topic: Buffer): Promise<void>;
    destroy(options?: { force?: boolean }): Promise<void>;
    suspend(options?: { log?: (message: string) => void }): Promise<void>;
    resume(options?: { log?: (message: string) => void }): Promise<void>;
    on(event: "connection", listener: (socket: Duplex, info: PeerInfo) => void): this;
    on(event: "update", listener: () => void): this;
    on(event: "ban", listener: (peerInfo: PeerInfo, error: Error) => void): this;
  }
}

declare module "hypercore" {
  import { Duplex } from "node:stream";

  interface HypercoreOptions<T> {
    name?: string;
    key?: Buffer;
    valueEncoding?: "json" | "utf-8" | "binary";
  }

  export default class Hypercore<T = Buffer> {
    constructor(storage: string, key?: Buffer, options?: HypercoreOptions<T>);
    key: Buffer;
    length: number;
    writable: boolean;
    static createProtocolStream(
      isInitiator: boolean | NodeJS.ReadWriteStream,
      options?: object
    ): Duplex & { noiseStream: { userData: unknown; opened: Promise<void> } };
    ready(): Promise<void>;
    update(options?: { wait?: boolean; force?: boolean; timeout?: number }): Promise<boolean>;
    download(range?: {
      start?: number;
      end?: number;
      linear?: boolean;
      activeRequests?: unknown;
    }): { destroy(): void };
    append(block: T | T[]): Promise<{ length: number; byteLength: number }>;
    get(index: number, options?: object): Promise<T>;
    createReadStream(options?: object): AsyncIterable<T>;
    close(): Promise<void>;
  }
}

declare module "corestore" {
  import Hypercore from "hypercore";

  interface KeyPair {
    publicKey: Buffer;
    secretKey: Buffer;
  }

  interface CorestoreOptions {
    primaryKey?: Buffer;
    writable?: boolean;
    unsafe?: boolean;
  }

  interface GetOptions<T> {
    name?: string;
    key?: Buffer;
    valueEncoding?: "json" | "utf-8" | "binary";
  }

  export default class Corestore {
    constructor(storage: string, options?: CorestoreOptions);
    ready(): Promise<void>;
    namespace(name: string): Corestore;
    get<T = Buffer>(options: GetOptions<T>): Hypercore<T>;
    replicate(stream: NodeJS.ReadWriteStream): NodeJS.ReadWriteStream;
    close(): Promise<void>;
    createKeyPair(name: string, namespace?: Buffer): Promise<KeyPair>;
  }
}

declare module "hyperbee" {
  import Hypercore from "hypercore";

  interface HyperbeeOptions {
    keyEncoding?: "utf-8" | "binary" | "json";
    valueEncoding?: "utf-8" | "binary" | "json";
  }

  export default class Hyperbee<K = string, V = Buffer> {
    constructor(core: Hypercore<unknown>, options?: HyperbeeOptions);
    ready(): Promise<void>;
    put(key: K, value: V, options?: object): Promise<void>;
    del(key: K, options?: object): Promise<void>;
    get(key: K): Promise<{ key: K; value: V } | null>;
    createReadStream(options?: { gte?: string; lt?: string }): AsyncIterable<{ key: K; value: V }>;
    close(): Promise<void>;
  }
}
