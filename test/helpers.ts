import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import DHT from "hyperdht";

export async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate a free port"));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

export async function createBootstrapNode(): Promise<{
  bootstrap: string[];
  destroy(): Promise<void>;
}> {
  const port = await findFreePort();
  const node = DHT.bootstrapper(port, "127.0.0.1");
  await node.ready();

  return {
    bootstrap: [`127.0.0.1:${port}`],
    async destroy() {
      await node.destroy();
    }
  };
}

export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  options?: { timeoutMs?: number; intervalMs?: number; message?: string }
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const intervalMs = options?.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(options?.message ?? `Condition was not met within ${timeoutMs}ms`);
}
