import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
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

test("context commands allow running agent commands without --data-dir", async () => {
  const rootDir = await createTempDir("emporion-context-");
  const dataDir = path.join(rootDir, "agent-a");
  const contextFile = path.join(rootDir, "contexts.v1.json");
  const previousContextFile = process.env.EMPORION_CONTEXTS_FILE;
  process.env.EMPORION_CONTEXTS_FILE = contextFile;

  try {
    const addCapture = createCaptureIo();
    assert.equal(
      await runCli(["context", "add", "--name", "agent-a", "--data-dir", dataDir, "--make-active"], addCapture.io),
      0
    );
    const addPayload = JSON.parse(addCapture.stdout.join("")) as { activeContext: string };
    assert.equal(addPayload.activeContext, "agent-a");

    const initCapture = createCaptureIo();
    assert.equal(
      await runCli(["agent", "init", "--display-name", "Context Agent"], initCapture.io),
      0
    );
    const initPayload = JSON.parse(initCapture.stdout.join("")) as {
      identity: { did: string };
    };
    assert.equal(initPayload.identity.did.startsWith("did:peer:"), true);

    const showCapture = createCaptureIo();
    assert.equal(
      await runCli(["agent", "show", "--context", "agent-a"], showCapture.io),
      0
    );
    const showPayload = JSON.parse(showCapture.stdout.join("")) as {
      identity: { did: string };
    };
    assert.equal(showPayload.identity.did, initPayload.identity.did);
  } finally {
    if (previousContextFile === undefined) {
      delete process.env.EMPORION_CONTEXTS_FILE;
    } else {
      process.env.EMPORION_CONTEXTS_FILE = previousContextFile;
    }
    await removeTempDir(rootDir);
  }
});

test("unknown --context fails early with a clear error", async () => {
  const rootDir = await createTempDir("emporion-context-missing-");
  const contextFile = path.join(rootDir, "contexts.v1.json");
  const previousContextFile = process.env.EMPORION_CONTEXTS_FILE;
  process.env.EMPORION_CONTEXTS_FILE = contextFile;

  try {
    const capture = createCaptureIo();
    assert.equal(await runCli(["agent", "show", "--context", "missing-context"], capture.io), 1);
    assert.equal(capture.stderr.join("").includes("Unknown context: missing-context"), true);
  } finally {
    if (previousContextFile === undefined) {
      delete process.env.EMPORION_CONTEXTS_FILE;
    } else {
      process.env.EMPORION_CONTEXTS_FILE = previousContextFile;
    }
    await removeTempDir(rootDir);
  }
});

test("deal/proof commands enforce proof-gated settlement by default", async () => {
  const dataDir = await createTempDir("emporion-deal-");
  const workerDataDir = await createTempDir("emporion-deal-worker-");

  try {
    assert.equal(await runCli(["agent", "init", "--data-dir", dataDir]), 0);
    assert.equal(await runCli(["agent", "init", "--data-dir", workerDataDir]), 0);
    const workerShowCapture = createCaptureIo();
    assert.equal(await runCli(["agent", "show", "--data-dir", workerDataDir], workerShowCapture.io), 0);
    const workerDid = (JSON.parse(workerShowCapture.stdout.join("")) as { identity: { did: string } }).identity.did;

    const openCapture = createCaptureIo();
    assert.equal(
      await runCli(
        [
          "deal",
          "open",
          "--data-dir",
          dataDir,
          "--intent",
          "buy",
          "--marketplace",
          "coding",
          "--title",
          "Need a report",
          "--amount-sats",
          "1000"
        ],
        openCapture.io
      ),
      0
    );
    const openPayload = JSON.parse(openCapture.stdout.join("")) as {
      dealId: string;
      changedObjects: Array<{ kind: string; id: string }>;
    };
    const request = openPayload.changedObjects.find((entry) => entry.kind === "request");
    assert.ok(request);

    const proposeCapture = createCaptureIo();
    assert.equal(
      await runCli(
        [
          "deal",
          "propose",
          "--data-dir",
          dataDir,
          "--target-id",
          request.id,
          "--amount-sats",
          "1000",
          "--proposer-did",
          workerDid
        ],
        proposeCapture.io
      ),
      0
    );
    const proposePayload = JSON.parse(proposeCapture.stdout.join("")) as {
      changedObjects: Array<{ kind: string; id: string }>;
    };
    const offer = proposePayload.changedObjects.find((entry) => entry.kind === "offer");
    assert.ok(offer);

    assert.equal(await runCli(["deal", "accept", "--data-dir", dataDir, "--proposal-id", offer.id]), 0);

    assert.equal(
      await runCli(
        [
          "deal",
          "start",
          "--data-dir",
          dataDir,
          "--proposal-id",
          offer.id,
          "--scope",
          "Deliver one report",
          "--milestone-id",
          "m1",
          "--milestone-title",
          "Report",
          "--deadline",
          "2026-12-31T23:59:59Z",
          "--deliverable-kind",
          "artifact",
          "--required-artifact-kind",
          "report"
        ]
      ),
      0
    );

    assert.equal(
      await runCli(
        [
          "proof",
          "submit",
          "--data-dir",
          dataDir,
          "--deal-id",
          openPayload.dealId,
          "--milestone-id",
          "m1",
          "--proof-preset",
          "simple-artifact",
          "--artifact-id",
          "report-v1",
          "--artifact-hash",
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ]
      ),
      0
    );

    const blockedSettlementCapture = createCaptureIo();
    assert.equal(
      await runCli(
        [
          "settlement",
          "invoice",
          "create",
          "--data-dir",
          dataDir,
          "--deal-id",
          openPayload.dealId,
          "--amount-sats",
          "1000"
        ],
        blockedSettlementCapture.io
      ),
      1
    );
    assert.equal(blockedSettlementCapture.stderr.join("").includes("proof-gated"), true);

    assert.equal(
      await runCli(
        ["proof", "accept", "--data-dir", dataDir, "--deal-id", openPayload.dealId, "--milestone-id", "m1"]
      ),
      0
    );

    const statusCapture = createCaptureIo();
    assert.equal(
      await runCli(["settlement", "status", "--data-dir", dataDir, "--deal-id", openPayload.dealId], statusCapture.io),
      0
    );
    const statusPayload = JSON.parse(statusCapture.stdout.join("")) as { stage: string };
    assert.equal(statusPayload.stage, "proof_accepted");
  } finally {
    await Promise.allSettled([removeTempDir(dataDir), removeTempDir(workerDataDir)]);
  }
});

test("wallet unlock/lock works through daemon commands without env var forwarding", async () => {
  const dataDir = await createTempDir("emporion-wallet-unlock-");
  const bootstrapNode = await createBootstrapNode();
  const previousWalletKey = process.env.EMPORION_WALLET_KEY;
  delete process.env.EMPORION_WALLET_KEY;

  try {
    assert.equal(
      await runCli(
        [
          "daemon",
          "start",
          "--data-dir",
          dataDir,
          "--bootstrap",
          bootstrapNode.bootstrap[0] as string,
          "--log-level",
          "error"
        ]
      ),
      0
    );

    await waitFor(async () => {
      const statusCapture = createCaptureIo();
      const exitCode = await runCli(["daemon", "status", "--data-dir", dataDir], statusCapture.io);
      return exitCode === 0;
    }, { timeoutMs: 10_000 });

    assert.equal(
      await runCli(
        [
          "wallet",
          "connect",
          "nwc",
          "--data-dir",
          dataDir,
          "--wallet-key",
          "session-wallet-key",
          "--connection-uri",
          "nwc+https://wallet.example/rpc?token=session"
        ]
      ),
      0
    );

    const lockCapture = createCaptureIo();
    assert.equal(await runCli(["wallet", "lock", "--data-dir", dataDir], lockCapture.io), 0);
    const lockPayload = JSON.parse(lockCapture.stdout.join("")) as {
      wallet: { connected: boolean; locked: boolean };
    };
    assert.equal(lockPayload.wallet.connected, true);
    assert.equal(lockPayload.wallet.locked, true);

    const unlockCapture = createCaptureIo();
    assert.equal(
      await runCli(
        ["wallet", "unlock", "--data-dir", dataDir, "--wallet-key", "session-wallet-key"],
        unlockCapture.io
      ),
      0
    );
    const unlockPayload = JSON.parse(unlockCapture.stdout.join("")) as {
      wallet: { connected: boolean; locked: boolean };
    };
    assert.equal(unlockPayload.wallet.connected, true);
    assert.equal(unlockPayload.wallet.locked, false);
  } finally {
    await Promise.allSettled([
      runCli(["daemon", "stop", "--data-dir", dataDir]),
      bootstrapNode.destroy(),
      removeTempDir(dataDir)
    ]);
    if (previousWalletKey === undefined) {
      delete process.env.EMPORION_WALLET_KEY;
    } else {
      process.env.EMPORION_WALLET_KEY = previousWalletKey;
    }
  }
});
