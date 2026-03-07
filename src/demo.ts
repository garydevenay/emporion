import { once } from "node:events";

import { AgentTransport } from "./transport.js";
import type { TopicRef } from "./types.js";

interface DemoOptions {
  dataDir: string;
  bootstrap?: string[];
  marketplace?: string;
  company?: string;
  agentTopic?: boolean;
  appendMessage?: string;
}

function parseArgs(argv: string[]): DemoOptions {
  const options: DemoOptions = {
    dataDir: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--data-dir":
        options.dataDir = next ?? "";
        index += 1;
        break;
      case "--bootstrap":
        options.bootstrap = (next ?? "")
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        index += 1;
        break;
      case "--marketplace":
        options.marketplace = next ?? "";
        index += 1;
        break;
      case "--company":
        options.company = next ?? "";
        index += 1;
        break;
      case "--agent-topic":
        options.agentTopic = true;
        break;
      case "--append":
        options.appendMessage = next ?? "";
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.dataDir.trim().length === 0) {
    throw new Error("Usage: npm run demo -- --data-dir <path> [--bootstrap host:port] [--marketplace id] [--company id] [--agent-topic] [--append message]");
  }

  return options;
}

async function printNewFeedEntries(
  label: string,
  feed: Awaited<ReturnType<AgentTransport["openFeed"]>>,
  seenLengths: Map<string, number>,
  key: string
): Promise<void> {
  if (!feed.writable) {
    await feed.update({ wait: false });
  }

  const seenLength = seenLengths.get(key) ?? 0;
  if (feed.length <= seenLength) {
    return;
  }

  for (let index = seenLength; index < feed.length; index += 1) {
    const value = await feed.get(index);
    process.stdout.write(`${label} entry #${index}: ${JSON.stringify(value)}\n`);
  }

  seenLengths.set(key, feed.length);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const transport = await AgentTransport.create({
    dataDir: options.dataDir,
    bootstrap: options.bootstrap,
    logLevel: "info"
  });

  await transport.start();

  const topics: TopicRef[] = [];
  if (options.marketplace) {
    topics.push({ kind: "marketplace", marketplaceId: options.marketplace });
  }
  if (options.company) {
    topics.push({ kind: "company", companyId: options.company });
  }
  if (options.agentTopic) {
    topics.push({ kind: "agent", agentDid: transport.identity.did });
  }

  for (const topic of topics) {
    await transport.joinTopic(topic);
  }

  const localEventsFeed = await transport.openFeed("events");
  const localEventsKey = localEventsFeed.key.toString("hex");
  const seenLengths = new Map<string, number>();
  const announcedRemoteFeeds = new Set<string>();
  const localLabel = `agent:${transport.identity.did} local`;

  process.stdout.write(`Agent DID: ${transport.identity.did}\n`);
  process.stdout.write(`Noise key: ${transport.identity.noisePublicKey}\n`);
  process.stdout.write(`Control feed: ${transport.identity.controlFeedKey}\n`);
  process.stdout.write(`Events feed: ${localEventsKey}\n`);
  process.stdout.write("Remote peer events will appear as observed entries, not as local appends.\n");

  if (options.appendMessage && options.appendMessage.trim().length > 0) {
    await localEventsFeed.append({
      type: "demo-message",
      body: options.appendMessage,
      senderDid: transport.identity.did,
      createdAt: new Date().toISOString()
    });
  }

  const interval = setInterval(() => {
    void (async () => {
      await printNewFeedEntries(localLabel, localEventsFeed, seenLengths, localEventsKey);

      for (const session of transport.getPeerSessions().values()) {
        const remoteEventsDescriptor = session.replication.find((descriptor) => descriptor.name === "events");
        if (!remoteEventsDescriptor) {
          continue;
        }

        const remoteFeed = transport.getRemoteFeed(remoteEventsDescriptor.key);
        if (!remoteFeed) {
          continue;
        }

        if (!announcedRemoteFeeds.has(remoteEventsDescriptor.key)) {
          announcedRemoteFeeds.add(remoteEventsDescriptor.key);
          process.stdout.write(
            `agent:${transport.identity.did} following remote events from ${session.remoteDid} on feed ${remoteEventsDescriptor.key}\n`
          );
        }

        await printNewFeedEntries(
          `agent:${transport.identity.did} observed remote:${session.remoteDid}`,
          remoteFeed,
          seenLengths,
          remoteEventsDescriptor.key
        );
      }
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`${message}\n`);
    });
  }, 2_000);

  const shutdown = async (): Promise<void> => {
    clearInterval(interval);
    await transport.stop();
  };

  const waitForExitSignal = Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  await waitForExitSignal;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
