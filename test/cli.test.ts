import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { probeDaemonStatus } from "../src/daemon.js";
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

test("CLI can initialize an agent profile and show it", async () => {
  const dataDir = await createTempDir("emporion-cli-agent-");

  try {
    const initCapture = createCaptureIo();
    const initExitCode = await runCli(
      ["agent", "init", "--data-dir", dataDir, "--display-name", "Agent A", "--bio", "Builds the market"],
      initCapture.io
    );
    assert.equal(initExitCode, 0);

    const initPayload = JSON.parse(initCapture.stdout.join(""));
    assert.equal(initPayload.identity.did.startsWith("did:peer:"), true);
    assert.equal(initPayload.profile.displayName, "Agent A");

    const showCapture = createCaptureIo();
    const showExitCode = await runCli(["agent", "show", "--data-dir", dataDir], showCapture.io);
    assert.equal(showExitCode, 0);

    const showPayload = JSON.parse(showCapture.stdout.join(""));
    assert.equal(showPayload.profile.bio, "Builds the market");
    assert.equal(showPayload.identity.did, initPayload.identity.did);
  } finally {
    await removeTempDir(dataDir);
  }
});

test("CLI can create company and market objects, then list marketplace entries", async () => {
  const dataDir = await createTempDir("emporion-cli-market-");

  try {
    const companyCapture = createCaptureIo();
    assert.equal(
      await runCli(["company", "create", "--data-dir", dataDir, "--name", "Emporion Labs"], companyCapture.io),
      0
    );
    const companyPayload = JSON.parse(companyCapture.stdout.join(""));
    const companyDid = companyPayload.companyDid as string;

    const joinCapture = createCaptureIo();
    assert.equal(
      await runCli(
        ["company", "join-market", "--data-dir", dataDir, "--company-did", companyDid, "--marketplace", "coding"],
        joinCapture.io
      ),
      0
    );

    const listingCapture = createCaptureIo();
    assert.equal(
      await runCli(
        [
          "market",
          "listing",
          "publish",
          "--data-dir",
          dataDir,
          "--marketplace",
          "coding",
          "--seller-did",
          companyDid,
          "--title",
          "Protocol design review",
          "--amount-sats",
          "150000"
        ],
        listingCapture.io
      ),
      0
    );
    const listingPayload = JSON.parse(listingCapture.stdout.join(""));
    const listingId = listingPayload.objectId as string;

    const agreementCapture = createCaptureIo();
    assert.equal(
      await runCli(
        [
          "market",
          "agreement",
          "create",
          "--data-dir",
          dataDir,
          "--source-kind",
          "listing",
          "--source-id",
          listingId,
          "--deliverable",
          "Review the architecture"
        ],
        agreementCapture.io
      ),
      0
    );
    const agreementPayload = JSON.parse(agreementCapture.stdout.join(""));
    assert.equal(agreementPayload.state.status, "active");

    const listCapture = createCaptureIo();
    assert.equal(await runCli(["market", "list", "--data-dir", dataDir, "--marketplace", "coding"], listCapture.io), 0);
    const listPayload = JSON.parse(listCapture.stdout.join(""));
    assert.equal(Array.isArray(listPayload.entries), true);
    assert.equal(listPayload.entries.length, 2);
  } finally {
    await removeTempDir(dataDir);
  }
});

test("CLI daemon start, status, and stop work against a custom bootstrap node", async () => {
  const dataDir = await createTempDir("emporion-cli-daemon-");
  const bootstrapNode = await createBootstrapNode();

  try {
    const startCapture = createCaptureIo();
    const startExitCode = await runCli(
      [
        "daemon",
        "start",
        "--data-dir",
        dataDir,
        "--bootstrap",
        bootstrapNode.bootstrap[0] as string,
        "--marketplace",
        "coding",
        "--agent-topic",
        "--log-level",
        "error"
      ],
      startCapture.io
    );
    assert.equal(startExitCode, 0);

    const startPayload = JSON.parse(startCapture.stdout.join(""));
    assert.equal(startPayload.status.identity.did.startsWith("did:peer:"), true);
    assert.equal(startPayload.status.topics.length, 2);

    const statusCapture = createCaptureIo();
    assert.equal(await runCli(["daemon", "status", "--data-dir", dataDir], statusCapture.io), 0);
    const statusPayload = JSON.parse(statusCapture.stdout.join(""));
    assert.equal(statusPayload.status.identity.did, startPayload.status.identity.did);
    assert.equal(statusPayload.status.healthy, true);

    const stopCapture = createCaptureIo();
    assert.equal(await runCli(["daemon", "stop", "--data-dir", dataDir], stopCapture.io), 0);
    const stopPayload = JSON.parse(stopCapture.stdout.join(""));
    assert.equal(stopPayload.stopped, true);
    assert.equal(await probeDaemonStatus(dataDir, 500), null);
  } finally {
    await Promise.allSettled([runCli(["daemon", "stop", "--data-dir", dataDir]), bootstrapNode.destroy(), removeTempDir(dataDir)]);
  }
});

test("CLI proxies protocol commands through a running daemon", async () => {
  const dataDir = await createTempDir("emporion-cli-daemon-proxy-");
  const bootstrapNode = await createBootstrapNode();

  try {
    const startCapture = createCaptureIo();
    assert.equal(
      await runCli(
        [
          "daemon",
          "start",
          "--data-dir",
          dataDir,
          "--bootstrap",
          bootstrapNode.bootstrap[0] as string,
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

    await waitFor(async () => probeDaemonStatus(dataDir, 500), {
      message: "Daemon did not become available for proxy test"
    });

    const companyCapture = createCaptureIo();
    assert.equal(
      await runCli(["company", "create", "--data-dir", dataDir, "--name", "Daemon Company"], companyCapture.io),
      0
    );
    const companyPayload = JSON.parse(companyCapture.stdout.join(""));
    const companyDid = companyPayload.companyDid as string;

    const listingCapture = createCaptureIo();
    assert.equal(
      await runCli(
        [
          "market",
          "listing",
          "publish",
          "--data-dir",
          dataDir,
          "--marketplace",
          "coding",
          "--seller-did",
          companyDid,
          "--title",
          "Daemon-backed listing",
          "--amount-sats",
          "200000"
        ],
        listingCapture.io
      ),
      0
    );

    const listCapture = createCaptureIo();
    assert.equal(await runCli(["market", "list", "--data-dir", dataDir, "--marketplace", "coding"], listCapture.io), 0);
    const listPayload = JSON.parse(listCapture.stdout.join(""));
    assert.equal(Array.isArray(listPayload.entries), true);
    assert.equal(listPayload.entries.length >= 1, true);
  } finally {
    await Promise.allSettled([runCli(["daemon", "stop", "--data-dir", dataDir]), bootstrapNode.destroy(), removeTempDir(dataDir)]);
  }
});
