import { createHash, randomUUID } from "node:crypto";
import { openSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type { AgentIdentity, ReplicationDescriptor, TopicJoinState } from "./types.js";
import type { SupportedProtocolDescriptor } from "./protocol/versioning.js";
import type { DaemonWalletStatus } from "./wallet/types.js";

const DEFAULT_DAEMON_TIMEOUT_MS = 5_000;

export interface LocalControlEndpoint {
  kind: "unix" | "named-pipe";
  path: string;
}

export interface DaemonStatus {
  dataDir: string;
  pid: number;
  startedAt: string;
  identity: AgentIdentity;
  runtimeEndpoint: string;
  logPath: string;
  topics: TopicJoinState[];
  connectedPeers: Array<{
    remoteDid: string;
    remoteNoisePublicKey: string;
    remoteControlFeedKey: string;
    source: string;
    supportedProtocols: SupportedProtocolDescriptor[];
    replication: ReplicationDescriptor[];
  }>;
  wallet: DaemonWalletStatus;
  healthy: boolean;
}

export interface DaemonCommandRequest {
  id: string;
  commandPath: string[];
  options: Record<string, string[]>;
}

export interface DaemonCommandResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

function normalizeDataDir(dataDir: string): string {
  return path.resolve(dataDir);
}

export function getDaemonRuntimeDir(dataDir: string): string {
  return path.join(normalizeDataDir(dataDir), "runtime");
}

export function getDaemonPidPath(dataDir: string): string {
  return path.join(getDaemonRuntimeDir(dataDir), "daemon.pid");
}

export function getDaemonLogPath(dataDir: string): string {
  return path.join(getDaemonRuntimeDir(dataDir), "daemon.log");
}

export function getLocalControlEndpoint(dataDir: string): LocalControlEndpoint {
  const normalized = normalizeDataDir(dataDir);
  if (process.platform === "win32") {
    const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 24);
    return {
      kind: "named-pipe",
      path: `\\\\.\\pipe\\emporion-${digest}`
    };
  }

  return {
    kind: "unix",
    path: path.join(getDaemonRuntimeDir(normalized), "daemon.sock")
  };
}

export async function ensureDaemonRuntimeDir(dataDir: string): Promise<string> {
  const runtimeDir = getDaemonRuntimeDir(dataDir);
  await mkdir(runtimeDir, { recursive: true });
  return runtimeDir;
}

export async function readDaemonPid(dataDir: string): Promise<number | null> {
  try {
    const value = await readFile(getDaemonPidPath(dataDir), "utf8");
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeDaemonPid(dataDir: string, pid: number): Promise<void> {
  await ensureDaemonRuntimeDir(dataDir);
  await writeFile(getDaemonPidPath(dataDir), `${pid}\n`, "utf8");
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    return code === "EPERM";
  }
}

async function removePathIfPresent(targetPath: string): Promise<void> {
  await rm(targetPath, { force: true });
}

export async function cleanupStaleDaemonArtifacts(dataDir: string): Promise<void> {
  const endpoint = getLocalControlEndpoint(dataDir);
  await removePathIfPresent(getDaemonPidPath(dataDir));
  if (endpoint.kind === "unix") {
    await removePathIfPresent(endpoint.path);
  }
}

function writeFrame(socket: net.Socket, payload: unknown): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(body.byteLength, 0);

    socket.write(Buffer.concat([header, body]), (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function readFrame<T>(socket: net.Socket, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let expectedLength: number | null = null;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for daemon IPC frame after ${timeoutMs}ms`));
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
      reject(error);
    }

    function onClose(): void {
      cleanup();
      reject(new Error("Daemon IPC connection closed before a complete frame was received"));
    }

    function onData(chunk: Buffer): void {
      buffer = Buffer.concat([buffer, chunk]);
      if (expectedLength === null && buffer.byteLength >= 4) {
        expectedLength = buffer.readUInt32BE(0);
        buffer = buffer.subarray(4);
      }
      if (expectedLength === null || buffer.byteLength < expectedLength) {
        return;
      }

      const payload = buffer.subarray(0, expectedLength);
      cleanup();
      try {
        resolve(JSON.parse(payload.toString("utf8")) as T);
      } catch (error) {
        reject(error);
      }
    }

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once("end", onClose);
  });
}

export async function sendDaemonCommand(
  dataDir: string,
  request: Omit<DaemonCommandRequest, "id">,
  timeoutMs = DEFAULT_DAEMON_TIMEOUT_MS
): Promise<DaemonCommandResponse> {
  const endpoint = getLocalControlEndpoint(dataDir);
  const socket = net.createConnection(endpoint.path);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to daemon endpoint ${endpoint.path}`));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  try {
    const message: DaemonCommandRequest = {
      id: randomUUID(),
      ...request
    };
    await writeFrame(socket, message);
    const response = await readFrame<DaemonCommandResponse>(socket, timeoutMs);
    if (response.id !== message.id) {
      throw new Error("Daemon IPC correlation ID mismatch");
    }
    return response;
  } finally {
    socket.destroy();
  }
}

export async function probeDaemonStatus(dataDir: string, timeoutMs = DEFAULT_DAEMON_TIMEOUT_MS): Promise<DaemonStatus | null> {
  const endpoint = getLocalControlEndpoint(dataDir);
  const pid = await readDaemonPid(dataDir);

  if (pid === null) {
    if (endpoint.kind === "unix") {
      try {
        await stat(endpoint.path);
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }

  try {
    const response = await sendDaemonCommand(dataDir, {
      commandPath: ["daemon", "status"],
      options: {}
    }, timeoutMs);
    if (!response.ok) {
      throw new Error(response.error ?? "Daemon reported an unknown status failure");
    }
    return response.result as DaemonStatus;
  } catch (error) {
    if (pid !== null && isProcessAlive(pid)) {
      throw new Error(`Daemon for ${normalizeDataDir(dataDir)} is running but not responding: ${(error as Error).message}`);
    }
    await cleanupStaleDaemonArtifacts(dataDir);
    return null;
  }
}

export function daemonRequestFromParsed(commandPath: string[], options: Record<string, string[]>): Omit<DaemonCommandRequest, "id"> {
  return {
    commandPath,
    options
  };
}

export function daemonRequestOptionsToRecord(options: Map<string, string[]>): Record<string, string[]> {
  return Object.fromEntries([...options.entries()].map(([key, values]) => [key, [...values]]));
}

export function daemonOptionsRecordToMap(options: Record<string, string[]>): Map<string, string[]> {
  return new Map(Object.entries(options).map(([key, values]) => [key, [...values]]));
}

export function openDaemonLogFd(dataDir: string): number {
  const logPath = getDaemonLogPath(dataDir);
  return openSync(logPath, "a");
}

export interface AgentDaemonOptions {
  dataDir: string;
  statusProvider(): DaemonStatus;
  commandHandler(request: DaemonCommandRequest): Promise<unknown>;
  onShutdown(): Promise<void>;
}

export class AgentDaemon {
  private readonly dataDir: string;
  private readonly endpoint: LocalControlEndpoint;
  private readonly statusProvider: AgentDaemonOptions["statusProvider"];
  private readonly commandHandler: AgentDaemonOptions["commandHandler"];
  private readonly onShutdown: AgentDaemonOptions["onShutdown"];
  private readonly server: net.Server;
  private shutdownResolve: (() => void) | null = null;
  private readonly shutdownPromise: Promise<void>;
  private stopping = false;
  private started = false;

  public constructor(options: AgentDaemonOptions) {
    this.dataDir = normalizeDataDir(options.dataDir);
    this.endpoint = getLocalControlEndpoint(this.dataDir);
    this.statusProvider = options.statusProvider;
    this.commandHandler = options.commandHandler;
    this.onShutdown = options.onShutdown;
    this.server = net.createServer((socket) => {
      void this.handleConnection(socket);
    });
    this.shutdownPromise = new Promise<void>((resolve) => {
      this.shutdownResolve = resolve;
    });
  }

  public async start(): Promise<void> {
    await ensureDaemonRuntimeDir(this.dataDir);
    if (this.endpoint.kind === "unix") {
      await removePathIfPresent(this.endpoint.path);
    }
    await writeDaemonPid(this.dataDir, process.pid);
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.endpoint.path, () => {
        this.server.off("error", reject);
        this.started = true;
        resolve();
      });
    });
  }

  public async waitForShutdown(): Promise<void> {
    await this.shutdownPromise;
  }

  public async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    try {
      if (this.started) {
        await new Promise<void>((resolve, reject) => {
          this.server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
      await this.onShutdown();
    } finally {
      this.started = false;
      await cleanupStaleDaemonArtifacts(this.dataDir);
    }
  }

  private async handleConnection(socket: net.Socket): Promise<void> {
    let requestId: string = randomUUID();
    try {
      const request = await readFrame<DaemonCommandRequest>(socket, DEFAULT_DAEMON_TIMEOUT_MS);
      requestId = request.id;
      if (!Array.isArray(request.commandPath)) {
        throw new Error("Daemon commandPath must be an array");
      }
      if (request.commandPath.length === 2 && request.commandPath[0] === "daemon" && request.commandPath[1] === "status") {
        await writeFrame(socket, {
          id: request.id,
          ok: true,
          result: this.statusProvider()
        } satisfies DaemonCommandResponse);
        socket.end();
        return;
      }
      if (request.commandPath.length === 2 && request.commandPath[0] === "daemon" && request.commandPath[1] === "stop") {
        await writeFrame(socket, {
          id: request.id,
          ok: true,
          result: this.statusProvider()
        } satisfies DaemonCommandResponse);
        socket.end(() => {
          void this.requestShutdown();
        });
        return;
      }

      const result = await this.commandHandler(request);
      await writeFrame(socket, {
        id: request.id,
        ok: true,
        result
      } satisfies DaemonCommandResponse);
      socket.end();
    } catch (error) {
      const response: DaemonCommandResponse = {
        id: requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
      try {
        await writeFrame(socket, response);
      } catch {
        // Ignore secondary write failures on broken IPC sockets.
      }
      socket.end();
    }
  }

  private async requestShutdown(): Promise<void> {
    if (!this.shutdownResolve) {
      return;
    }
    this.shutdownResolve();
    this.shutdownResolve = null;
  }
}
