import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { WalletAuthError, WalletUnavailableError } from "../src/errors.js";
import { WalletConfigStore } from "../src/wallet/config-store.js";
import { NwcWalletAdapter } from "../src/wallet/nwc-adapter.js";
import {
  NostrWalletConnectAdapter,
  parseNostrWalletConnectMetadata,
  type NostrNwcClient
} from "../src/wallet/nostr-nwc-adapter.js";
import { WalletService } from "../src/wallet/service.js";
import type { WalletAdapter } from "../src/wallet/types.js";
import { createBootstrapNode, createTempDir, removeTempDir, waitFor } from "./helpers.js";

function createCaptureIo(): {
  stdout: string[];
  stderr: string[];
  io: {
    stdout(message: string): void;
    stderr(message: string): void;
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout(message: string) {
        stdout.push(message);
      },
      stderr(message: string) {
        stderr.push(message);
      }
    }
  };
}

async function forceStopDaemon(dataDir: string): Promise<void> {
  const capture = createCaptureIo();
  await runCli(["daemon", "stop", "--data-dir", dataDir], capture.io);

  const killedPids = new Set<number>();
  const pidPath = path.join(dataDir, "runtime", "daemon.pid");
  try {
    const pid = Number.parseInt((await readFile(pidPath, "utf8")).trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error("pid-not-valid");
    }
    try {
      process.kill(pid, "SIGTERM");
      killedPids.add(pid);
    } catch {
      // continue with process table fallback
    }
  } catch {
    // pid file not present; nothing else to stop.
  }

  const processTable = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  for (const line of processTable.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (!trimmed.includes("src/cli.ts daemon run") || !trimmed.includes(`--data-dir ${dataDir}`)) {
      continue;
    }
    const firstSpace = trimmed.indexOf(" ");
    if (firstSpace === -1) {
      continue;
    }
    const pid = Number.parseInt(trimmed.slice(0, firstSpace).trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
      killedPids.add(pid);
    } catch {
      // Ignore already-dead processes.
    }
  }

  for (const pid of killedPids) {
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, { timeoutMs: 5_000, intervalMs: 100 });
  }
}

async function createMockNwcServer(options?: {
  requireToken?: string;
  hangCreateInvoice?: boolean;
  createInvoiceDelayMs?: number;
}): Promise<{
  connectionUri: string;
  state: {
    invoiceStatusByRef: Map<string, string>;
    paymentStatusByRef: Map<string, string>;
    createInvoiceCalls: number;
    payInvoiceCalls: number;
  };
  close(): Promise<void>;
}> {
  const state = {
    invoiceStatusByRef: new Map<string, string>(),
    paymentStatusByRef: new Map<string, string>(),
    createInvoiceCalls: 0,
    payInvoiceCalls: 0
  };

  const server = http.createServer((req, res) => {
    const expectedToken = options?.requireToken;
    if (expectedToken) {
      const authorization = req.headers.authorization;
      if (authorization !== `Bearer ${expectedToken}`) {
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
    }

    const bodyChunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => bodyChunks.push(chunk));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(bodyChunks).toString("utf8")) as {
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };

      if (payload.method === "create_invoice") {
        state.createInvoiceCalls += 1;
        const createInvoiceDelayMs = options?.createInvoiceDelayMs ?? (options?.hangCreateInvoice ? 2_000 : 0);
        if (createInvoiceDelayMs > 0) {
          const delayed = setTimeout(() => {
            if (!res.writableEnded) {
              res.setHeader("content-type", "application/json");
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: payload.id,
                  result: {
                    bolt11: "lnbc1delayed",
                    external_ref: "inv-delayed",
                    status: "created"
                  }
                })
              );
            }
          }, createInvoiceDelayMs);
          delayed.unref();
          return;
        }
        const invoiceId = `inv-${state.createInvoiceCalls}`;
        state.invoiceStatusByRef.set(invoiceId, "created");
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              bolt11: `lnbc1${invoiceId}`,
              external_ref: invoiceId,
              status: "created"
            }
          })
        );
        return;
      }

      if (payload.method === "pay_invoice") {
        state.payInvoiceCalls += 1;
        const paymentId = `pay-${state.payInvoiceCalls}`;
        state.paymentStatusByRef.set(paymentId, "pending");
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              external_ref: paymentId,
              amount_sats: 1000,
              fee_sats: 2,
              status: "pending"
            }
          })
        );
        return;
      }

      if (payload.method === "get_invoice") {
        const params = payload.params ?? {};
        const externalRef = String(params.external_ref ?? "");
        const status = state.invoiceStatusByRef.get(externalRef) ?? "created";
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              status
            }
          })
        );
        return;
      }

      if (payload.method === "get_payment") {
        const params = payload.params ?? {};
        const externalRef = String(params.external_ref ?? "");
        const status = state.paymentStatusByRef.get(externalRef) ?? "pending";
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              status,
              fee_sats: 2
            }
          })
        );
        return;
      }

      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          error: {
            code: -32601,
            message: `Unsupported method: ${payload.method}`
          }
        })
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  const token = options?.requireToken ?? "test-token";
  const connectionUri = `nwc+http://127.0.0.1:${address.port}/rpc?token=${encodeURIComponent(token)}`;

  return {
    connectionUri,
    state,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

test("wallet config store encrypts secrets and supports key rotation", async () => {
  const dataDir = await createTempDir("emporion-wallet-config-");

  try {
    const store = new WalletConfigStore(dataDir);
    await store.writeConnection(
      {
        backend: "nwc",
        network: "bitcoin",
        connectionUri: "nwc+https://wallet.example/rpc?token=abc",
        endpoint: "https://wallet.example/rpc",
        connectedAt: new Date().toISOString()
      },
      "first-key"
    );

    const initial = await store.readConnection("first-key");
    assert.equal(initial?.connectionUri.includes("token=abc"), true);

    await assert.rejects(() => store.readConnection("wrong-key"), WalletAuthError);

    await store.rotateKey("first-key", "second-key");
    await assert.rejects(() => store.readConnection("first-key"), WalletAuthError);

    const rotated = await store.readConnection("second-key");
    assert.equal(rotated?.endpoint, "https://wallet.example/rpc");
  } finally {
    await removeTempDir(dataDir);
  }
});

test("nwc adapter maps invoice and payment calls and handles timeout/auth errors", async () => {
  const goodServer = await createMockNwcServer({ requireToken: "good-token" });
  const timeoutServer = await createMockNwcServer({ requireToken: "slow-token", hangCreateInvoice: true });

  try {
    const adapter = new NwcWalletAdapter(goodServer.connectionUri.replace("test-token", "good-token"));
    const invoice = await adapter.createInvoice({ amountSats: 1200, memo: "build" });
    assert.equal(invoice.status, "created");

    const payment = await adapter.payInvoice({ invoice: invoice.bolt11 });
    assert.equal(payment.status, "pending");

    const invoiceStatus = await adapter.getInvoiceStatus(invoice.externalRef);
    assert.equal(invoiceStatus, "created");

    const paymentStatus = await adapter.getPaymentStatus(payment.externalRef);
    assert.equal(paymentStatus.status, "pending");

    const unauthorizedAdapter = new NwcWalletAdapter(goodServer.connectionUri.replace("good-token", "wrong-token"));
    await assert.rejects(() => unauthorizedAdapter.createInvoice({ amountSats: 500 }), WalletAuthError);

    const timeoutAdapter = new NwcWalletAdapter(timeoutServer.connectionUri.replace("test-token", "slow-token"), 50);
    await assert.rejects(() => timeoutAdapter.createInvoice({ amountSats: 700 }), WalletUnavailableError);
  } finally {
    await Promise.all([goodServer.close(), timeoutServer.close()]);
  }
});

test("nostr+walletconnect adapter parses metadata and maps NIP-47 responses", async () => {
  const walletPubkey = "a".repeat(64);
  const secret = "b".repeat(64);
  const connectionUri = `nostr+walletconnect://${walletPubkey}?relay=wss://relay.one&relay=wss://relay.two&secret=${secret}`;

  const metadata = parseNostrWalletConnectMetadata(connectionUri);
  assert.equal(metadata.endpoint, `nostr+walletconnect://${walletPubkey}?relay=${encodeURIComponent("wss://relay.one")}`);

  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client: NostrNwcClient = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "make_invoice") {
        return {
          result_type: "make_invoice",
          result: {
            type: "incoming",
            invoice: "lnbc1nostr",
            payment_hash: "hash-invoice-1",
            expires_at: Math.floor(Date.now() / 1000) + 120
          }
        };
      }
      if (method === "pay_invoice") {
        return {
          result_type: "pay_invoice",
          result: {
            payment_hash: "hash-payment-1",
            preimage: "preimage-1",
            amount: 1_000_000,
            fees_paid: 5_000
          }
        };
      }
      if (method === "lookup_invoice") {
        return {
          result_type: "lookup_invoice",
          result: {
            payment_hash: String(params.payment_hash ?? ""),
            settled_at: Math.floor(Date.now() / 1000),
            fees_paid: 3_000
          }
        };
      }
      return {
        error: {
          code: "NOT_IMPLEMENTED",
          message: `Unsupported method ${method}`
        }
      };
    },
    close() {
      // no-op
    }
  };

  const adapter = new NostrWalletConnectAdapter(connectionUri, { client });
  const invoice = await adapter.createInvoice({ amountSats: 2500, memo: "nostr invoice" });
  assert.equal(invoice.bolt11, "lnbc1nostr");
  assert.equal(invoice.externalRef, "hash-invoice-1");
  assert.equal(invoice.status, "created");

  const payment = await adapter.payInvoice({ invoice: "lnbc1to-pay" });
  assert.equal(payment.externalRef, "hash-payment-1");
  assert.equal(payment.status, "succeeded");
  assert.equal(payment.feeSats, 5);

  const invoiceStatus = await adapter.getInvoiceStatus("hash-invoice-1");
  assert.equal(invoiceStatus, "paid");

  const paymentStatus = await adapter.getPaymentStatus("hash-payment-1");
  assert.equal(paymentStatus.status, "succeeded");
  assert.equal(paymentStatus.feeSats, 3);

  assert.equal(calls.some((call) => call.method === "make_invoice"), true);
  const makeInvoiceCall = calls.find((call) => call.method === "make_invoice");
  assert.ok(makeInvoiceCall);
  assert.equal(makeInvoiceCall.params.amount, 2_500_000);
  assert.equal(calls.some((call) => call.method === "pay_invoice"), true);
  assert.equal(calls.filter((call) => call.method === "lookup_invoice").length >= 2, true);

  const unauthorizedClient: NostrNwcClient = {
    async request() {
      return {
        error: {
          code: "UNAUTHORIZED",
          message: "wallet rejected request"
        }
      };
    },
    close() {
      // no-op
    }
  };
  const unauthorizedAdapter = new NostrWalletConnectAdapter(connectionUri, { client: unauthorizedClient });
  await assert.rejects(() => unauthorizedAdapter.createInvoice({ amountSats: 1000 }), WalletAuthError);
});

test("nostr+walletconnect adapter accepts provider response variants", async () => {
  const walletPubkey = "c".repeat(64);
  const secret = "d".repeat(64);
  const connectionUri = `nostr+walletconnect://${walletPubkey}?relay=wss://relay.one&secret=${secret}`;
  const expectedHashHex = "e".repeat(64);
  const expectedHashBase64 = Buffer.from(expectedHashHex, "hex").toString("base64");

  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client: NostrNwcClient = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "make_invoice") {
        return {
          result_type: "make_invoice",
          result: {
            pr: "lnbc1variantinvoice",
            r_hash: expectedHashBase64
          }
        };
      }
      if (method === "pay_invoice") {
        return {
          result_type: "pay_invoice",
          result: {
            preimage: "preimage-variant",
            amount: 1_200_000,
            fees_paid: 4_000
          }
        };
      }
      if (method === "lookup_invoice") {
        return {
          result_type: "lookup_invoice",
          result: {
            payment_hash: String(params.payment_hash ?? ""),
            invoice: String(params.invoice ?? ""),
            settled_at: Math.floor(Date.now() / 1000)
          }
        };
      }
      return {
        error: {
          code: "NOT_IMPLEMENTED",
          message: `Unsupported method ${method}`
        }
      };
    },
    close() {
      // no-op
    }
  };

  const adapter = new NostrWalletConnectAdapter(connectionUri, { client });
  const created = await adapter.createInvoice({ amountSats: 500 });
  assert.equal(created.bolt11, "lnbc1variantinvoice");
  assert.equal(created.externalRef, expectedHashHex);

  const invoiceStatus = await adapter.getInvoiceStatus(created.externalRef);
  assert.equal(invoiceStatus, "paid");

  const paid = await adapter.payInvoice({ invoice: "lnbc1outgoingvariant" });
  assert.equal(paid.externalRef, "lnbc1outgoingvariant");
  assert.equal(paid.status, "succeeded");

  const paymentStatus = await adapter.getPaymentStatus(paid.externalRef);
  assert.equal(paymentStatus.status, "succeeded");

  const lookupCalls = calls.filter((entry) => entry.method === "lookup_invoice");
  const invoiceLookupByHash = lookupCalls.find((entry) => entry.params.payment_hash === expectedHashHex);
  assert.ok(invoiceLookupByHash);
  const outgoingLookupByInvoice = lookupCalls.find((entry) => entry.params.invoice === "lnbc1outgoingvariant");
  assert.ok(outgoingLookupByInvoice);
});

test("nostr+walletconnect adapter accepts result string invoice fallback", async () => {
  const walletPubkey = "1".repeat(64);
  const secret = "2".repeat(64);
  const connectionUri = `nostr+walletconnect://${walletPubkey}?relay=wss://relay.one&secret=${secret}`;

  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client: NostrNwcClient = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "make_invoice") {
        return {
          result_type: "make_invoice",
          result: "lnbc1stringresultinvoice"
        };
      }
      if (method === "lookup_invoice") {
        return {
          result_type: "lookup_invoice",
          result: {
            invoice: String(params.invoice ?? ""),
            settled_at: Math.floor(Date.now() / 1000)
          }
        };
      }
      return {
        result: {
          preimage: "ok"
        }
      };
    },
    close() {
      // no-op
    }
  };

  const adapter = new NostrWalletConnectAdapter(connectionUri, { client });
  const created = await adapter.createInvoice({ amountSats: 1000 });
  assert.equal(created.bolt11, "lnbc1stringresultinvoice");
  assert.equal(created.externalRef, "lnbc1stringresultinvoice");

  const status = await adapter.getInvoiceStatus(created.externalRef);
  assert.equal(status, "paid");

  const lookupCall = calls.find((entry) => entry.method === "lookup_invoice" && entry.params.invoice === "lnbc1stringresultinvoice");
  assert.ok(lookupCall);
});

test("wallet service auto-settle is idempotent per event and lightning reference", async () => {
  const dataDir = await createTempDir("emporion-wallet-auto-settle-");
  const originalKey = process.env.EMPORION_WALLET_KEY;
  process.env.EMPORION_WALLET_KEY = "auto-settle-key";

  let payCalls = 0;
  const stubAdapter: WalletAdapter = {
    async createInvoice() {
      return {
        bolt11: "lnbc1stub",
        externalRef: "inv-stub",
        status: "created"
      };
    },
    async payInvoice() {
      payCalls += 1;
      return {
        externalRef: `pay-${payCalls}`,
        amountSats: 100,
        feeSats: 1,
        status: "succeeded"
      };
    },
    async getInvoiceStatus() {
      return "created";
    },
    async getPaymentStatus() {
      return { status: "succeeded" };
    },
    async disconnect() {
      // no-op
    }
  };

  try {
    const service = await WalletService.create({
      dataDir,
      env: process.env,
      adapterFactory: () => stubAdapter
    });

    await service.connect("nwc+http://127.0.0.1:7777/rpc?token=stub");

    const first = await service.attemptAutoSettle({
      triggerObjectKind: "offer",
      triggerObjectId: "offer-1",
      eventId: "event-1",
      lightningRef: {
        type: "bolt11",
        network: "bitcoin",
        reference: "lnbc1example"
      },
      amountSats: 100
    });
    assert.equal(first.executed, true);
    assert.equal(first.state, "succeeded");

    const second = await service.attemptAutoSettle({
      triggerObjectKind: "offer",
      triggerObjectId: "offer-1",
      eventId: "event-1",
      lightningRef: {
        type: "bolt11",
        network: "bitcoin",
        reference: "lnbc1example"
      },
      amountSats: 100
    });
    assert.equal(second.executed, false);
    assert.equal(second.deduped, true);
    assert.equal(payCalls, 1);

    const payments = await service.listLedger({ kind: "payment" });
    assert.equal(payments.length, 1);

    await service.close();
  } finally {
    if (originalKey === undefined) {
      delete process.env.EMPORION_WALLET_KEY;
    } else {
      process.env.EMPORION_WALLET_KEY = originalKey;
    }
    await removeTempDir(dataDir);
  }
});

test("wallet CLI commands validate options and usage output includes wallet family", async () => {
  const dataDir = await createTempDir("emporion-wallet-cli-");
  const previousKey = process.env.EMPORION_WALLET_KEY;
  const walletPubkey = "c".repeat(64);
  const secret = "d".repeat(64);

  try {
    delete process.env.EMPORION_WALLET_KEY;

    const helpCapture = createCaptureIo();
    assert.equal(await runCli(["wallet", "status", "--help"], helpCapture.io), 0);
    assert.equal(helpCapture.stdout.join("").includes("emporion wallet connect nwc"), true);

    const invalidKindCapture = createCaptureIo();
    assert.equal(
      await runCli(["wallet", "ledger", "list", "--data-dir", dataDir, "--kind", "bad-kind"], invalidKindCapture.io),
      1
    );
    assert.equal(invalidKindCapture.stderr.join("").includes("--kind must be one of"), true);

    const connectCapture = createCaptureIo();
    assert.equal(
      await runCli(
        ["wallet", "connect", "nwc", "--data-dir", dataDir, "--connection-uri", "nwc+https://wallet.example/rpc?token=a"],
        connectCapture.io
      ),
      1
    );
    assert.equal(connectCapture.stderr.join("").includes("Wallet key is required in EMPORION_WALLET_KEY"), true);

    process.env.EMPORION_WALLET_KEY = "cli-nostr-key";
    const nostrConnectCapture = createCaptureIo();
    assert.equal(
      await runCli(
        [
          "wallet",
          "connect",
          "nwc",
          "--data-dir",
          dataDir,
          "--connection-uri",
          `nostr+walletconnect://${walletPubkey}?relay=wss://relay.example&secret=${secret}`
        ],
        nostrConnectCapture.io
      ),
      0
    );
    const nostrPayload = JSON.parse(nostrConnectCapture.stdout.join("")) as { endpoint: string };
    assert.equal(
      nostrPayload.endpoint.startsWith(`nostr+walletconnect://${walletPubkey}?relay=`),
      true
    );
  } finally {
    if (previousKey === undefined) {
      delete process.env.EMPORION_WALLET_KEY;
    } else {
      process.env.EMPORION_WALLET_KEY = previousKey;
    }
    await removeTempDir(dataDir);
  }
});

test("wallet connect can be executed through a running daemon without daemon restart", async () => {
  const dataDir = await createTempDir("emp-w-proxy-");
  const bootstrap = await createBootstrapNode();
  const nwcServer = await createMockNwcServer({ requireToken: "proxy-token" });
  const previousKey = process.env.EMPORION_WALLET_KEY;
  process.env.EMPORION_WALLET_KEY = "proxy-wallet-key";

  try {
    const daemonStartCapture = createCaptureIo();
    assert.equal(
      await runCli([
        "daemon",
        "start",
        "--data-dir",
        dataDir,
        "--bootstrap",
        bootstrap.bootstrap[0] as string,
        "--log-level",
        "error"
      ], daemonStartCapture.io),
      0
    );

    const connectCapture = createCaptureIo();
    assert.equal(
      await runCli(
        [
          "wallet",
          "connect",
          "nwc",
          "--data-dir",
          dataDir,
          "--connection-uri",
          nwcServer.connectionUri.replace("test-token", "proxy-token")
        ],
        connectCapture.io
      ),
      0
    );
    const connectPayload = JSON.parse(connectCapture.stdout.join("")) as {
      wallet: {
        connected: boolean;
        autoSettleEnabled: boolean;
      };
    };
    assert.equal(connectPayload.wallet.connected, true);
    assert.equal(connectPayload.wallet.autoSettleEnabled, true);

    const statusCapture = createCaptureIo();
    assert.equal(await runCli(["daemon", "status", "--data-dir", dataDir], statusCapture.io), 0);
    const statusPayload = JSON.parse(statusCapture.stdout.join("")) as {
      status: {
        wallet: {
          connected: boolean;
          autoSettleEnabled: boolean;
        };
      };
    };
    assert.equal(statusPayload.status.wallet.connected, true);
    assert.equal(statusPayload.status.wallet.autoSettleEnabled, true);
  } finally {
    await Promise.allSettled([forceStopDaemon(dataDir), bootstrap.destroy(), nwcServer.close(), removeTempDir(dataDir)]);
    if (previousKey === undefined) {
      delete process.env.EMPORION_WALLET_KEY;
    } else {
      process.env.EMPORION_WALLET_KEY = previousKey;
    }
  }
});

test("wallet invoice create succeeds through daemon proxy when backend exceeds default IPC timeout", async () => {
  const dataDir = await createTempDir("emp-w-proxy-invoice-");
  const bootstrap = await createBootstrapNode();
  const nwcServer = await createMockNwcServer({
    requireToken: "proxy-slow-token",
    createInvoiceDelayMs: 6_000
  });
  const previousKey = process.env.EMPORION_WALLET_KEY;
  process.env.EMPORION_WALLET_KEY = "proxy-wallet-key";

  try {
    const daemonStartCapture = createCaptureIo();
    assert.equal(
      await runCli([
        "daemon",
        "start",
        "--data-dir",
        dataDir,
        "--bootstrap",
        bootstrap.bootstrap[0] as string,
        "--log-level",
        "error"
      ], daemonStartCapture.io),
      0
    );

    const connectCapture = createCaptureIo();
    assert.equal(
      await runCli(
        [
          "wallet",
          "connect",
          "nwc",
          "--data-dir",
          dataDir,
          "--connection-uri",
          nwcServer.connectionUri.replace("test-token", "proxy-slow-token")
        ],
        connectCapture.io
      ),
      0
    );

    const invoiceCapture = createCaptureIo();
    assert.equal(
      await runCli(
        [
          "wallet",
          "invoice",
          "create",
          "--data-dir",
          dataDir,
          "--amount-sats",
          "1000",
          "--memo",
          "slow invoice"
        ],
        invoiceCapture.io
      ),
      0
    );
    const invoicePayload = JSON.parse(invoiceCapture.stdout.join("")) as {
      command: string;
      bolt11: string;
    };
    assert.equal(invoicePayload.command, "wallet.invoice.create");
    assert.equal(invoicePayload.bolt11, "lnbc1delayed");
  } finally {
    await Promise.allSettled([forceStopDaemon(dataDir), bootstrap.destroy(), nwcServer.close(), removeTempDir(dataDir)]);
    if (previousKey === undefined) {
      delete process.env.EMPORION_WALLET_KEY;
    } else {
      process.env.EMPORION_WALLET_KEY = previousKey;
    }
  }
});

test("daemon wallet runtime auto-settles accepted offers and recovers pending payments after restart", async () => {
  const dataDir = await createTempDir("emporion-wallet-daemon-");
  const bootstrap = await createBootstrapNode();
  const nwcServer = await createMockNwcServer({ requireToken: "daemon-token" });
  const previousKey = process.env.EMPORION_WALLET_KEY;
  process.env.EMPORION_WALLET_KEY = "daemon-wallet-key";

  try {
    const connectCapture = createCaptureIo();
    assert.equal(
      await runCli(
        [
          "wallet",
          "connect",
          "nwc",
          "--data-dir",
          dataDir,
          "--connection-uri",
          nwcServer.connectionUri.replace("test-token", "daemon-token")
        ],
        connectCapture.io
      ),
      0
    );

    const startCapture = createCaptureIo();
    assert.equal(
      await runCli(
        [
          "daemon",
          "start",
          "--data-dir",
          dataDir,
          "--bootstrap",
          bootstrap.bootstrap[0] as string,
          "--marketplace",
          "coding",
          "--agent-topic",
          "--log-level",
          "error"
        ],
        startCapture.io
      ),
      0
    );

    const offerCapture = createCaptureIo();
    assert.equal(
      await runCli(
        [
          "market",
          "offer",
          "submit",
          "--data-dir",
          dataDir,
          "--marketplace",
          "coding",
          "--amount-sats",
          "1000",
          "--lightning-ref",
          "bolt11:bitcoin:lnbc1auto"
        ],
        offerCapture.io
      ),
      0
    );
    const offerPayload = JSON.parse(offerCapture.stdout.join("")) as { objectId: string };

    const acceptCapture = createCaptureIo();
    assert.equal(
      await runCli(
        ["market", "offer", "accept", "--data-dir", dataDir, "--id", offerPayload.objectId],
        acceptCapture.io
      ),
      0
    );

    await waitFor(async () => nwcServer.state.payInvoiceCalls === 1, {
      timeoutMs: 12_000,
      message: "Daemon auto-settle did not call pay_invoice"
    });

    await waitFor(async () => {
      const ledgerCapture = createCaptureIo();
      const exitCode = await runCli(
        ["wallet", "ledger", "list", "--data-dir", dataDir, "--kind", "payment", "--status", "pending"],
        ledgerCapture.io
      );
      if (exitCode !== 0) {
        return false;
      }
      const payload = JSON.parse(ledgerCapture.stdout.join("")) as { entries: unknown[] };
      return payload.entries.length === 1;
    }, {
      timeoutMs: 12_000,
      message: "Pending payment was not persisted"
    });

    await forceStopDaemon(dataDir);

    // Simulate settlement while daemon is offline, then verify poll recovery after restart.
    nwcServer.state.paymentStatusByRef.set("pay-1", "succeeded");

    const restartCapture = createCaptureIo();
    assert.equal(
      await runCli(
        [
          "daemon",
          "start",
          "--data-dir",
          dataDir,
          "--bootstrap",
          bootstrap.bootstrap[0] as string,
          "--marketplace",
          "coding",
          "--agent-topic",
          "--log-level",
          "error"
        ],
        restartCapture.io
      ),
      0
    );

    await waitFor(async () => {
      const ledgerCapture = createCaptureIo();
      const exitCode = await runCli(
        ["wallet", "ledger", "list", "--data-dir", dataDir, "--kind", "payment", "--status", "succeeded"],
        ledgerCapture.io
      );
      if (exitCode !== 0) {
        return false;
      }
      const payload = JSON.parse(ledgerCapture.stdout.join("")) as { entries: unknown[] };
      return payload.entries.length === 1;
    }, {
      timeoutMs: 12_000,
      message: "Daemon restart did not recover pending payment state"
    });

    const statusCapture = createCaptureIo();
    assert.equal(await runCli(["daemon", "status", "--data-dir", dataDir], statusCapture.io), 0);
    const statusPayload = JSON.parse(statusCapture.stdout.join("")) as {
      status: {
        wallet: {
          connected: boolean;
          backend: string;
          network: string;
          autoSettleEnabled: boolean;
        };
      };
    };
    assert.equal(statusPayload.status.wallet.connected, true);
    assert.equal(statusPayload.status.wallet.backend, "nwc");
    assert.equal(statusPayload.status.wallet.network, "bitcoin");
    assert.equal(statusPayload.status.wallet.autoSettleEnabled, true);
  } finally {
    await Promise.allSettled([
      forceStopDaemon(dataDir),
      bootstrap.destroy(),
      nwcServer.close(),
      removeTempDir(dataDir)
    ]);
    if (previousKey === undefined) {
      delete process.env.EMPORION_WALLET_KEY;
    } else {
      process.env.EMPORION_WALLET_KEY = previousKey;
    }
  }
});

test("wallet daemon starts with locked wallet when encrypted config exists without EMPORION_WALLET_KEY", async () => {
  const dataDir = await createTempDir("emporion-wallet-daemon-key-");
  const bootstrap = await createBootstrapNode();
  const nwcServer = await createMockNwcServer({ requireToken: "key-test-token" });
  const previousKey = process.env.EMPORION_WALLET_KEY;

  try {
    process.env.EMPORION_WALLET_KEY = "initial-key";
    const connectCapture = createCaptureIo();
    assert.equal(
      await runCli([
        "wallet",
        "connect",
        "nwc",
        "--data-dir",
        dataDir,
        "--connection-uri",
        nwcServer.connectionUri.replace("test-token", "key-test-token")
      ], connectCapture.io),
      0
    );

    delete process.env.EMPORION_WALLET_KEY;

    const capture = createCaptureIo();
    assert.equal(
      await runCli(
        [
          "daemon",
          "start",
          "--data-dir",
          dataDir,
          "--bootstrap",
          bootstrap.bootstrap[0] as string,
          "--log-level",
          "error"
        ],
        capture.io
      ),
      0
    );

    const statusCapture = createCaptureIo();
    assert.equal(await runCli(["daemon", "status", "--data-dir", dataDir], statusCapture.io), 0);
    const statusPayload = JSON.parse(statusCapture.stdout.join("")) as {
      status: {
        wallet: {
          connected: boolean;
          autoSettleEnabled: boolean;
        };
      };
    };
    assert.equal(statusPayload.status.wallet.connected, true);
    assert.equal(statusPayload.status.wallet.autoSettleEnabled, false);
  } finally {
    await Promise.allSettled([forceStopDaemon(dataDir), bootstrap.destroy(), nwcServer.close(), removeTempDir(dataDir)]);
    if (previousKey === undefined) {
      delete process.env.EMPORION_WALLET_KEY;
    } else {
      process.env.EMPORION_WALLET_KEY = previousKey;
    }
  }
});
