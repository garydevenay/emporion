#!/usr/bin/env node

import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { closeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AgentDaemon,
  cleanupStaleDaemonArtifacts,
  daemonOptionsRecordToMap,
  daemonRequestFromParsed,
  daemonRequestOptionsToRecord,
  ensureDaemonRuntimeDir,
  getDaemonLogPath,
  getDaemonPidPath,
  getLocalControlEndpoint,
  openDaemonLogFd,
  probeDaemonStatus,
  sendDaemonCommand,
  type DaemonCommandRequest,
  type DaemonStatus
} from "./daemon.js";
import { AgentTransport } from "./transport.js";
import { createLogger, type LogLevel } from "./logger.js";
import { loadPersistentIdentityMaterial } from "./persistent-agent.js";
import * as Protocol from "./protocol/index.js";
import { sha256Hex, type ProtocolJsonObject, type ProtocolValue } from "./protocol/shared.js";
import type { IdentityMaterial } from "./identity.js";
import { TransportStorage } from "./storage.js";
import type { TopicRef, TransportConfig } from "./types.js";
import {
  WalletService,
  type AutoSettleCandidate
} from "./wallet/index.js";
import { ContextStore } from "./context-store.js";
import { DealsStore, type DealRecord, type DealStage } from "./experience/deals-store.js";

interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

interface ParsedArgs {
  commandPath: string[];
  options: Map<string, string[]>;
}

interface CliContext {
  dataDir: string;
  identityMaterial: IdentityMaterial;
  repository: Protocol.ProtocolRepository;
  transportStorage: TransportStorage;
  walletService: WalletService;
  signer: Protocol.ProtocolSigner;
}

type StateWithLatestEventId = { latestEventId: string; eventIds: string[] };
type CliContextRunner = <T>(dataDir: string, fn: (context: CliContext) => Promise<T>) => Promise<T>;

interface DispatchOptions {
  allowDaemonProxy: boolean;
}

const DEFAULT_DAEMON_PROXY_TIMEOUT_MS = 5_000;
const WALLET_DAEMON_PROXY_TIMEOUT_MS = 30_000;

const DEFAULT_IO: CliIo = {
  stdout(message) {
    process.stdout.write(message);
  },
  stderr(message) {
    process.stderr.write(message);
  }
};

const CLI_CONTEXT_STORAGE = new AsyncLocalStorage<CliContext>();

function parseArgs(argv: string[]): ParsedArgs {
  const commandPath: string[] = [];
  const options = new Map<string, string[]>();
  let index = 0;

  while (index < argv.length && !argv[index]?.startsWith("--")) {
    commandPath.push(argv[index] as string);
    index += 1;
  }

  while (index < argv.length) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token ?? ""}`);
    }

    const optionName = token.slice(2);
    if (optionName.length === 0) {
      throw new Error("Option names must not be blank");
    }

    const nextToken = argv[index + 1];
    const value = !nextToken || nextToken.startsWith("--") ? "true" : nextToken;
    const existing = options.get(optionName) ?? [];
    existing.push(value);
    options.set(optionName, existing);
    index += value === "true" ? 1 : 2;
  }

  return { commandPath, options };
}

function commandMatches(commandPath: string[], ...expected: string[]): boolean {
  return commandPath.length === expected.length && expected.every((value, index) => commandPath[index] === value);
}

function isContextCommand(commandPath: string[]): boolean {
  return commandPath[0] === "context";
}

function isWalletCommand(commandPath: string[]): boolean {
  return commandPath[0] === "wallet";
}

function getOptionValues(args: ParsedArgs, name: string): string[] {
  return args.options.get(name) ?? [];
}

function hasFlag(args: ParsedArgs, name: string): boolean {
  return getOptionValues(args, name).includes("true");
}

function getOptionalOption(args: ParsedArgs, name: string): string | undefined {
  const values = getOptionValues(args, name).filter((value) => value !== "true");
  return values.at(-1);
}

function requireOption(args: ParsedArgs, name: string): string {
  const value = getOptionalOption(args, name);
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required option --${name}`);
  }
  return value;
}

function getCsvOptionValues(args: ParsedArgs, name: string): string[] {
  return getOptionValues(args, name)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== "true");
}

function parsePositiveInteger(value: string, fieldName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, fieldName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
  return parsed;
}

function parseOptionalNonNegativeInteger(args: ParsedArgs, name: string): number | undefined {
  const value = getOptionalOption(args, name);
  return value === undefined ? undefined : parseNonNegativeInteger(value, `--${name}`);
}

function parseOptionalIsoTimestamp(args: ParsedArgs, name: string): string | undefined {
  const value = getOptionalOption(args, name);
  if (value === undefined) {
    return undefined;
  }
  const epochMs = Date.parse(value);
  if (Number.isNaN(epochMs)) {
    throw new Error(`--${name} must be a valid ISO-8601 timestamp`);
  }
  return new Date(epochMs).toISOString();
}

function parseEnum<T extends string>(value: string, fieldName: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(`${fieldName} must be one of: ${allowed.join(", ")}`);
}

function now(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isStateWithLatestEventId(value: unknown): value is StateWithLatestEventId {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<StateWithLatestEventId>).latestEventId === "string" &&
    Array.isArray((value as Partial<StateWithLatestEventId>).eventIds)
  );
}

function defaultObjectId(kind: string, seed: ProtocolValue): string {
  return `emporion:${kind}:${sha256Hex(seed)}`;
}

function toProtocolJsonObject<T extends object>(value: T): ProtocolJsonObject {
  return value as unknown as ProtocolJsonObject;
}

function toProtocolValue<T>(value: T): ProtocolValue {
  return value as unknown as ProtocolValue;
}

function parsePaymentTerms(
  args: ParsedArgs,
  options?: { amountOption?: string; currencyOption?: string; settlementOption?: string }
): Protocol.PaymentTerms {
  const amountOption = options?.amountOption ?? "amount-sats";
  const currencyOption = options?.currencyOption ?? "currency";
  const settlementOption = options?.settlementOption ?? "settlement";

  return {
    amountSats: parsePositiveInteger(requireOption(args, amountOption), `--${amountOption}`),
    currency: parseEnum(getOptionalOption(args, currencyOption) ?? "SAT", `--${currencyOption}`, ["BTC", "SAT"] as const),
    settlementMethod: parseEnum(
      getOptionalOption(args, settlementOption) ?? "lightning",
      `--${settlementOption}`,
      ["lightning", "custodial"] as const
    )
  };
}

function mergePaymentTerms(
  args: ParsedArgs,
  current: Protocol.PaymentTerms,
  options?: { amountOption?: string; currencyOption?: string; settlementOption?: string }
): Protocol.PaymentTerms {
  const amountOption = options?.amountOption ?? "amount-sats";
  const currencyOption = options?.currencyOption ?? "currency";
  const settlementOption = options?.settlementOption ?? "settlement";
  const amountValue = getOptionalOption(args, amountOption);
  const currencyValue = getOptionalOption(args, currencyOption);
  const settlementValue = getOptionalOption(args, settlementOption);

  return {
    amountSats: amountValue ? parsePositiveInteger(amountValue, `--${amountOption}`) : current.amountSats,
    currency: currencyValue
      ? parseEnum(currencyValue, `--${currencyOption}`, ["BTC", "SAT"] as const)
      : current.currency,
    settlementMethod: settlementValue
      ? parseEnum(settlementValue, `--${settlementOption}`, ["lightning", "custodial"] as const)
      : current.settlementMethod
  };
}

function parseLightningRefs(args: ParsedArgs): Protocol.LightningReference[] {
  return getOptionValues(args, "lightning-ref")
    .filter((value) => value !== "true")
    .map((value) => {
      const match = /^([^:]+):([^:]+):(.+)$/.exec(value);
      if (!match) {
        throw new Error("--lightning-ref must use <type>:<network>:<reference>");
      }
      const [, type, network, reference] = match;
      if (!type || !network || !reference) {
        throw new Error("--lightning-ref must use <type>:<network>:<reference>");
      }
      return {
        type: parseEnum(type, "--lightning-ref type", [
          "bolt11",
          "bolt12-offer",
          "bolt12-invoice-request",
          "custodial-payment-ref"
        ] as const),
        network: parseEnum(network, "--lightning-ref network", [
          "bitcoin",
          "testnet",
          "signet",
          "regtest"
        ] as const),
        reference
      };
    });
}

function parseJsonOption<T>(args: ParsedArgs, name: string): T {
  const value = requireOption(args, name);
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`--${name} must be valid JSON: ${(error as Error).message}`);
  }
}

function getUniqueOptionValues(args: ParsedArgs, name: string): string[] {
  return [...new Set(getOptionValues(args, name).filter((value) => value !== "true"))].sort();
}

function writeJson(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function normalizeDataDirPath(dataDir: string): string {
  return path.resolve(dataDir);
}

function parsedArgsFromCommand(
  commandPath: string[],
  options: Record<string, string | string[] | boolean | undefined>
): ParsedArgs {
  const map = new Map<string, string[]>();
  for (const [name, value] of Object.entries(options)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === "boolean") {
      if (value) {
        map.set(name, ["true"]);
      }
      continue;
    }
    if (Array.isArray(value)) {
      map.set(name, value.map((entry) => `${entry}`));
      continue;
    }
    map.set(name, [`${value}`]);
  }
  return {
    commandPath: [...commandPath],
    options: map
  };
}

async function runNestedCommand(commandPath: string[], options: Record<string, string | string[] | boolean | undefined>): Promise<unknown> {
  return executeCapturedInDaemon(parsedArgsFromCommand(commandPath, options));
}

function ensureObjectIdPrefix(objectId: string, prefixes: string[]): string {
  const trimmed = objectId.trim();
  if (!prefixes.some((prefix) => trimmed.startsWith(prefix))) {
    throw new Error(`Unsupported object id: ${trimmed}`);
  }
  return trimmed;
}

function stageOrder(stage: DealStage): number {
  switch (stage) {
    case "draft":
      return 0;
    case "negotiating":
      return 1;
    case "agreed":
      return 2;
    case "in_progress":
      return 3;
    case "proof_submitted":
      return 4;
    case "proof_accepted":
      return 5;
    case "settlement_pending":
      return 6;
    case "settled":
      return 7;
    case "closed":
      return 8;
  }
}

function stageAtLeast(current: DealStage, expected: DealStage): boolean {
  return stageOrder(current) >= stageOrder(expected);
}

function toChangedObjects(record: DealRecord): Array<{ kind: string; id: string }> {
  const entries: Array<{ kind: string; id: string }> = [];
  if (record.rootObjectKind && record.rootObjectId) entries.push({ kind: record.rootObjectKind, id: record.rootObjectId });
  if (record.proposalKind && record.proposalId) entries.push({ kind: record.proposalKind, id: record.proposalId });
  if (record.agreementId) entries.push({ kind: "agreement", id: record.agreementId });
  if (record.contractId) entries.push({ kind: "contract", id: record.contractId });
  if (record.evidenceId) entries.push({ kind: "evidence-bundle", id: record.evidenceId });
  if (record.invoiceId) entries.push({ kind: "invoice", id: record.invoiceId });
  if (record.paymentId) entries.push({ kind: "payment", id: record.paymentId });
  return entries;
}

function nextActionsForStage(stage: DealStage): string[] {
  switch (stage) {
    case "draft":
    case "negotiating":
      return ["deal.propose", "deal.accept"];
    case "agreed":
      return ["deal.start"];
    case "in_progress":
      return ["proof.submit"];
    case "proof_submitted":
      return ["proof.accept"];
    case "proof_accepted":
      return ["settlement.invoice.create", "settlement.pay"];
    case "settlement_pending":
      return ["settlement.pay", "settlement.status"];
    case "settled":
      return ["deal.status"];
    case "closed":
      return [];
  }
}

function writeDealResponse(io: CliIo, command: string, deal: DealRecord, overrides?: { safety?: { earlySettlementAllowed: boolean } }): void {
  writeJson(io, {
    command,
    dealId: deal.dealId,
    stage: deal.stage,
    changedObjects: toChangedObjects(deal),
    nextActions: nextActionsForStage(deal.stage),
    safety: {
      policy: "proof-gated",
      earlySettlementAllowed: overrides?.safety?.earlySettlementAllowed ?? false
    }
  });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Expected ${fieldName} to be a non-empty string`);
  }
  return value;
}

function inferIntentFromRootObjectKind(kind: "request" | "listing"): "buy" | "sell" {
  return kind === "request" ? "sell" : "buy";
}

function inferRootObjectKindFromId(objectId: string): "request" | "listing" {
  if (objectId.startsWith("emporion:request:")) {
    return "request";
  }
  if (objectId.startsWith("emporion:listing:")) {
    return "listing";
  }
  throw new Error(`Unsupported target object id for proposal: ${objectId}`);
}

function inferProposalKindFromId(proposalId: string): "offer" | "bid" {
  if (proposalId.startsWith("emporion:offer:")) {
    return "offer";
  }
  if (proposalId.startsWith("emporion:bid:")) {
    return "bid";
  }
  throw new Error(`Unsupported proposal id: ${proposalId}`);
}

async function openCliContext(dataDir: string): Promise<CliContext> {
  const identityMaterial = await loadPersistentIdentityMaterial(dataDir);
  const repository = await Protocol.ProtocolRepository.create(dataDir);
  const transportStorage = await TransportStorage.create(dataDir, identityMaterial.storagePrimaryKey, createLogger("error"));
  const walletService = await WalletService.create({ dataDir });
  await transportStorage.initializeDefaults();

  return {
    dataDir,
    identityMaterial,
    repository,
    transportStorage,
    walletService,
    signer: {
      did: identityMaterial.agentIdentity.did,
      publicKey: identityMaterial.transportKeyPair.publicKey,
      secretKey: identityMaterial.transportKeyPair.secretKey
    }
  };
}

async function closeCliContext(context: CliContext): Promise<void> {
  await context.walletService.close();
  await context.transportStorage.close();
  await context.repository.close();
}

async function withCliContext<T>(dataDir: string, fn: (context: CliContext) => Promise<T>): Promise<T> {
  const sharedContext = CLI_CONTEXT_STORAGE.getStore();
  if (sharedContext) {
    if (normalizeDataDirPath(sharedContext.dataDir) !== normalizeDataDirPath(dataDir)) {
      throw new Error(`Daemon context is bound to ${sharedContext.dataDir}, not ${dataDir}`);
    }
    return fn(sharedContext);
  }

  const context = await openCliContext(dataDir);
  try {
    return await CLI_CONTEXT_STORAGE.run(context, async () => fn(context));
  } finally {
    await closeCliContext(context);
  }
}

async function readRequiredState<TState>(
  repository: Protocol.ProtocolRepository,
  objectKind: Protocol.ProtocolObjectKind,
  objectId: string
): Promise<TState> {
  const state = await repository.readObjectState(objectKind, objectId);
  if (!state) {
    throw new Error(`No ${objectKind} state found for ${objectId}`);
  }
  return state as TState;
}

async function ensureAgentProfileExists(context: CliContext): Promise<Protocol.AgentProfileState> {
  const profile = await context.repository.readObjectState("agent-profile", context.identityMaterial.agentIdentity.did);
  if (profile) {
    return profile as Protocol.AgentProfileState;
  }

  const result = await appendEnvelope(context, {
    objectKind: "agent-profile",
    objectId: context.identityMaterial.agentIdentity.did,
    eventKind: "agent-profile.created",
    subjectId: context.identityMaterial.agentIdentity.did,
    payload: {}
  });

  return result.state as Protocol.AgentProfileState;
}

function listActiveSpaceMemberDids(context: CliContext, spaceId: string): string[] {
  const members: string[] = [];
  for (const membership of context.repository.getSnapshot().spaceMemberships.values()) {
    if (membership.spaceId === spaceId && membership.status !== "removed") {
      members.push(membership.memberDid);
    }
  }
  return [...new Set(members)].sort();
}

async function appendEnvelope<TPayload extends ProtocolJsonObject>(
  context: CliContext,
  input: {
    objectKind: Protocol.ProtocolObjectKind;
    objectId: string;
    eventKind: string;
    subjectId: string;
    payload: TPayload;
    attachments?: Protocol.ProtocolAttachment[];
    issuedAt?: string;
  }
): Promise<{ envelope: Protocol.ProtocolEnvelope<TPayload>; state: unknown }> {
  const currentState = await context.repository.readObjectState(input.objectKind, input.objectId);
  const previousEventIds = isStateWithLatestEventId(currentState) ? [currentState.latestEventId] : [];
  const unsignedEnvelope = Protocol.createUnsignedEnvelope({
    objectKind: input.objectKind,
    objectId: input.objectId,
    eventKind: input.eventKind,
    actorDid: context.identityMaterial.agentIdentity.did,
    subjectId: input.subjectId,
    issuedAt: input.issuedAt ?? now(),
    previousEventIds,
    payload: input.payload,
    ...(input.attachments ? { attachments: input.attachments } : {})
  });
  const envelope = Protocol.signProtocolEnvelope(unsignedEnvelope, context.signer);
  await context.repository.appendEnvelope(envelope);
  const nextState = await context.repository.readObjectState(input.objectKind, input.objectId);
  if (nextState) {
    const controlFeed = await context.transportStorage.openFeed("control");
    const announcement = Protocol.createProtocolAnnouncement(
      envelope,
      nextState as Protocol.DisseminationState
    );
    await controlFeed.append(Protocol.protocolAnnouncementToJson(announcement));
  }

  return {
    envelope,
    state: nextState
  };
}

async function handleAgentInit(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");

  await withCliContext(dataDir, async (context) => {
    const displayName = getOptionalOption(args, "display-name");
    const bio = getOptionalOption(args, "bio");
    const currentProfile = await context.repository.readObjectState("agent-profile", context.identityMaterial.agentIdentity.did);
    let mutation:
      | {
          envelope: Protocol.ProtocolEnvelope;
          state: unknown;
        }
      | undefined;

    if (!currentProfile) {
      mutation = await appendEnvelope(context, {
        objectKind: "agent-profile",
        objectId: context.identityMaterial.agentIdentity.did,
        eventKind: "agent-profile.created",
        subjectId: context.identityMaterial.agentIdentity.did,
        payload: {
          ...(displayName ? { displayName } : {}),
          ...(bio ? { bio } : {})
        }
      });
    } else if (displayName !== undefined || bio !== undefined) {
      const profile = currentProfile as Protocol.AgentProfileState;
      if (displayName !== profile.displayName || bio !== profile.bio) {
        mutation = await appendEnvelope(context, {
          objectKind: "agent-profile",
          objectId: context.identityMaterial.agentIdentity.did,
          eventKind: "agent-profile.updated",
          subjectId: context.identityMaterial.agentIdentity.did,
          payload: {
            ...(displayName !== undefined ? { displayName } : {}),
            ...(bio !== undefined ? { bio } : {})
          }
        });
      }
    }

    writeJson(io, {
      command: "agent.init",
      identity: context.identityMaterial.agentIdentity,
      profile:
        mutation?.state ??
        (await context.repository.readObjectState("agent-profile", context.identityMaterial.agentIdentity.did)),
      eventId: mutation?.envelope.eventId
    });
  });
}

async function handleAgentShow(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");

  await withCliContext(dataDir, async (context) => {
    writeJson(io, {
      command: "agent.show",
      identity: context.identityMaterial.agentIdentity,
      profile: await context.repository.readObjectState("agent-profile", context.identityMaterial.agentIdentity.did)
    });
  });
}

async function handleAgentPaymentEndpointAdd(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");

  await withCliContext(dataDir, async (context) => {
    await ensureAgentProfileExists(context);
    const capabilities = getCsvOptionValues(args, "capability");
    if (capabilities.length === 0) {
      throw new Error("At least one --capability is required");
    }
    const accountId = getOptionalOption(args, "account-id");
    const nodeUri = getOptionalOption(args, "node-uri");
    const bolt12Offer = getOptionalOption(args, "bolt12-offer");

    const endpoint: Protocol.PaymentEndpoint = {
      id: requireOption(args, "id"),
      network: parseEnum(getOptionalOption(args, "network") ?? "bitcoin", "--network", [
        "bitcoin",
        "testnet",
        "signet",
        "regtest"
      ] as const),
      custodial: hasFlag(args, "custodial"),
      capabilities,
      ...(accountId ? { accountId } : {}),
      ...(nodeUri ? { nodeUri } : {}),
      ...(bolt12Offer ? { bolt12Offer } : {})
    };

    const result = await appendEnvelope(context, {
      objectKind: "agent-profile",
      objectId: context.identityMaterial.agentIdentity.did,
      eventKind: "agent-profile.payment-endpoint-added",
      subjectId: context.identityMaterial.agentIdentity.did,
      payload: Protocol.paymentEndpointToJson(endpoint)
    });

    writeJson(io, {
      command: "agent.payment-endpoint.add",
      eventId: result.envelope.eventId,
      profile: result.state
    });
  });
}

async function handleAgentPaymentEndpointRemove(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const paymentEndpointId = requireOption(args, "payment-endpoint-id");

  await withCliContext(dataDir, async (context) => {
    await ensureAgentProfileExists(context);
    const result = await appendEnvelope(context, {
      objectKind: "agent-profile",
      objectId: context.identityMaterial.agentIdentity.did,
      eventKind: "agent-profile.payment-endpoint-removed",
      subjectId: context.identityMaterial.agentIdentity.did,
      payload: {
        paymentEndpointId
      }
    });

    writeJson(io, {
      command: "agent.payment-endpoint.remove",
      eventId: result.envelope.eventId,
      profile: result.state
    });
  });
}

async function handleAgentWalletAttestationAdd(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");

  await withCliContext(dataDir, async (context) => {
    await ensureAgentProfileExists(context);
    const attestedAt = getOptionalOption(args, "attested-at") ?? now();
    const artifact = getOptionalOption(args, "artifact") ?? "";
    const attestedCapacitySats = parseOptionalNonNegativeInteger(args, "capacity-sats");
    const artifactUri = getOptionalOption(args, "artifact-uri");
    const attestation: Protocol.CustodialWalletAttestationRef = {
      attestationId: requireOption(args, "attestation-id"),
      issuerDid: getOptionalOption(args, "issuer-did") ?? context.identityMaterial.agentIdentity.did,
      subjectDid: context.identityMaterial.agentIdentity.did,
      walletAccountId: requireOption(args, "wallet-account-id"),
      network: parseEnum(getOptionalOption(args, "network") ?? "bitcoin", "--network", [
        "bitcoin",
        "testnet",
        "signet",
        "regtest"
      ] as const),
      currency: parseEnum(getOptionalOption(args, "currency") ?? "SAT", "--currency", ["BTC", "SAT"] as const),
      attestedBalanceSats: parseNonNegativeInteger(requireOption(args, "balance-sats"), "--balance-sats"),
      ...(attestedCapacitySats !== undefined ? { attestedCapacitySats } : {}),
      attestedAt,
      expiresAt: requireOption(args, "expires-at"),
      artifactHash: Protocol.createCredentialArtifactHash(artifact),
      ...(artifactUri ? { artifactUri } : {})
    };

    const result = await appendEnvelope(context, {
      objectKind: "agent-profile",
      objectId: context.identityMaterial.agentIdentity.did,
      eventKind: "agent-profile.wallet-attestation-added",
      subjectId: context.identityMaterial.agentIdentity.did,
      payload: Protocol.custodialWalletAttestationToJson(attestation)
    });

    writeJson(io, {
      command: "agent.wallet-attestation.add",
      eventId: result.envelope.eventId,
      profile: result.state
    });
  });
}

async function handleAgentWalletAttestationRemove(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const attestationId = requireOption(args, "attestation-id");

  await withCliContext(dataDir, async (context) => {
    await ensureAgentProfileExists(context);
    const result = await appendEnvelope(context, {
      objectKind: "agent-profile",
      objectId: context.identityMaterial.agentIdentity.did,
      eventKind: "agent-profile.wallet-attestation-removed",
      subjectId: context.identityMaterial.agentIdentity.did,
      payload: {
        attestationId
      }
    });

    writeJson(io, {
      command: "agent.wallet-attestation.remove",
      eventId: result.envelope.eventId,
      profile: result.state
    });
  });
}

async function handleAgentFeedbackAdd(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");

  await withCliContext(dataDir, async (context) => {
    await ensureAgentProfileExists(context);
    const issuedAt = getOptionalOption(args, "issued-at") ?? now();
    const artifact = getOptionalOption(args, "artifact") ?? "";
    const headline = getOptionalOption(args, "headline");
    const comment = getOptionalOption(args, "comment");
    const expiresAt = getOptionalOption(args, "expires-at");
    const artifactUri = getOptionalOption(args, "artifact-uri");
    const revocationRef = getOptionalOption(args, "revocation-ref");
    const completionArtifactRef = getOptionalOption(args, "completion-artifact-ref");
    const rulingRef = getOptionalOption(args, "ruling-ref");
    const credential: Protocol.FeedbackCredentialRef = {
      credentialId: requireOption(args, "credential-id"),
      issuerDid: requireOption(args, "issuer-did"),
      subjectDid: context.identityMaterial.agentIdentity.did,
      relatedContractId: requireOption(args, "contract-id"),
      relatedAgreementId: requireOption(args, "agreement-id"),
      ...(completionArtifactRef ? { completionArtifactRef } : {}),
      ...(rulingRef ? { rulingRef } : {}),
      summary: {
        score: parseNonNegativeInteger(requireOption(args, "score"), "--score"),
        maxScore: parsePositiveInteger(requireOption(args, "max-score"), "--max-score"),
        ...(headline ? { headline } : {}),
        ...(comment ? { comment } : {})
      },
      issuedAt,
      ...(expiresAt ? { expiresAt } : {}),
      artifactHash: Protocol.createCredentialArtifactHash(artifact),
      ...(artifactUri ? { artifactUri } : {}),
      ...(revocationRef ? { revocationRef } : {})
    };

    const recorded = await appendEnvelope(context, {
      objectKind: "feedback-credential-ref",
      objectId: credential.credentialId,
      eventKind: "feedback-credential-ref.recorded",
      subjectId: credential.credentialId,
      payload: Protocol.feedbackCredentialRefToJson(credential),
      issuedAt
    });
    const added = await appendEnvelope(context, {
      objectKind: "agent-profile",
      objectId: context.identityMaterial.agentIdentity.did,
      eventKind: "agent-profile.feedback-credential-added",
      subjectId: context.identityMaterial.agentIdentity.did,
      payload: Protocol.feedbackCredentialRefToJson(credential)
    });

    writeJson(io, {
      command: "agent.feedback.add",
      feedbackEventId: recorded.envelope.eventId,
      profileEventId: added.envelope.eventId,
      profile: added.state,
      feedback: await context.repository.readObjectState("feedback-credential-ref", credential.credentialId)
    });
  });
}

async function handleAgentFeedbackRemove(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const credentialId = requireOption(args, "credential-id");

  await withCliContext(dataDir, async (context) => {
    await ensureAgentProfileExists(context);
    const feedbackState = await context.repository.readObjectState("feedback-credential-ref", credentialId);
    if (feedbackState) {
      await appendEnvelope(context, {
        objectKind: "feedback-credential-ref",
        objectId: credentialId,
        eventKind: "feedback-credential-ref.revoked",
        subjectId: credentialId,
        payload: {}
      });
    }

    const removed = await appendEnvelope(context, {
      objectKind: "agent-profile",
      objectId: context.identityMaterial.agentIdentity.did,
      eventKind: "agent-profile.feedback-credential-removed",
      subjectId: context.identityMaterial.agentIdentity.did,
      payload: {
        credentialId
      }
    });

    writeJson(io, {
      command: "agent.feedback.remove",
      profileEventId: removed.envelope.eventId,
      profile: removed.state,
      feedback: await context.repository.readObjectState("feedback-credential-ref", credentialId)
    });
  });
}

async function handleCompanyCreate(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");

  await withCliContext(dataDir, async (context) => {
    const issuedAt = now();
    const description = getOptionalOption(args, "description");
    const payload: Protocol.CompanyGenesisPayload = {
      name: requireOption(args, "name"),
      initialOwners: [context.identityMaterial.agentIdentity.did],
      ...(description ? { description } : {})
    };
    const companyDid = Protocol.deriveCompanyDidFromGenesis({
      actorDid: context.identityMaterial.agentIdentity.did,
      issuedAt,
      payload
    });
    const result = await appendEnvelope(context, {
      objectKind: "company",
      objectId: companyDid,
      eventKind: "company.genesis",
      subjectId: companyDid,
      payload: payload as unknown as ProtocolJsonObject,
      issuedAt
    });

    writeJson(io, {
      command: "company.create",
      companyDid,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleCompanyShow(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const companyDid = requireOption(args, "company-did");

  await withCliContext(dataDir, async (context) => {
    writeJson(io, {
      command: "company.show",
      state: await context.repository.readObjectState("company", companyDid)
    });
  });
}

async function handleCompanyUpdate(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const companyDid = requireOption(args, "company-did");
  const name = getOptionalOption(args, "name");
  const description = getOptionalOption(args, "description");
  if (name === undefined && description === undefined) {
    throw new Error("At least one of --name or --description is required");
  }

  await withCliContext(dataDir, async (context) => {
    const result = await appendEnvelope(context, {
      objectKind: "company",
      objectId: companyDid,
      eventKind: "company.profile-updated",
      subjectId: companyDid,
      payload: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {})
      }
    });

    writeJson(io, {
      command: "company.update",
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleCompanyRoleChange(
  args: ParsedArgs,
  io: CliIo,
  mode: "grant" | "revoke"
): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const companyDid = requireOption(args, "company-did");

  await withCliContext(dataDir, async (context) => {
    const result = await appendEnvelope(context, {
      objectKind: "company",
      objectId: companyDid,
      eventKind: mode === "grant" ? "company.role-granted" : "company.role-revoked",
      subjectId: companyDid,
      payload: {
        memberDid: requireOption(args, "member-did"),
        role: parseEnum(requireOption(args, "role"), "--role", ["owner", "operator", "member"] as const)
      }
    });

    writeJson(io, {
      command: mode === "grant" ? "company.grant-role" : "company.revoke-role",
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleCompanyMarketMembership(
  args: ParsedArgs,
  io: CliIo,
  mode: "join" | "leave"
): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const companyDid = requireOption(args, "company-did");
  const marketplaceId = requireOption(args, "marketplace");

  await withCliContext(dataDir, async (context) => {
    const result = await appendEnvelope(context, {
      objectKind: "company",
      objectId: companyDid,
      eventKind: mode === "join" ? "company.market-joined" : "company.market-left",
      subjectId: companyDid,
      payload: {
        marketplaceId
      }
    });

    writeJson(io, {
      command: mode === "join" ? "company.join-market" : "company.leave-market",
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleCompanyTreasuryAttest(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const companyDid = requireOption(args, "company-did");
  const attestedAt = getOptionalOption(args, "attested-at") ?? now();
  const artifact = getOptionalOption(args, "artifact") ?? "";

  await withCliContext(dataDir, async (context) => {
    const attestedCapacitySats = parseOptionalNonNegativeInteger(args, "capacity-sats");
    const artifactUri = getOptionalOption(args, "artifact-uri");
    const attestation: Protocol.CustodialWalletAttestationRef = {
      attestationId: requireOption(args, "attestation-id"),
      issuerDid: getOptionalOption(args, "issuer-did") ?? context.identityMaterial.agentIdentity.did,
      subjectDid: companyDid,
      walletAccountId: requireOption(args, "wallet-account-id"),
      network: parseEnum(getOptionalOption(args, "network") ?? "bitcoin", "--network", [
        "bitcoin",
        "testnet",
        "signet",
        "regtest"
      ] as const),
      currency: parseEnum(getOptionalOption(args, "currency") ?? "SAT", "--currency", ["BTC", "SAT"] as const),
      attestedBalanceSats: parseNonNegativeInteger(requireOption(args, "balance-sats"), "--balance-sats"),
      ...(attestedCapacitySats !== undefined ? { attestedCapacitySats } : {}),
      attestedAt,
      expiresAt: requireOption(args, "expires-at"),
      artifactHash: Protocol.createCredentialArtifactHash(artifact),
      ...(artifactUri ? { artifactUri } : {})
    };

    const result = await appendEnvelope(context, {
      objectKind: "company",
      objectId: companyDid,
      eventKind: "company.treasury-attested",
      subjectId: companyDid,
      payload: Protocol.custodialWalletAttestationToJson(attestation)
    });

    writeJson(io, {
      command: "company.treasury-attest",
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleCompanyTreasuryReserve(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const companyDid = requireOption(args, "company-did");
  const createdAt = getOptionalOption(args, "created-at") ?? now();

  await withCliContext(dataDir, async (context) => {
    const result = await appendEnvelope(context, {
      objectKind: "company",
      objectId: companyDid,
      eventKind: "company.treasury-reserved",
      subjectId: companyDid,
      payload: {
        reservationId: requireOption(args, "reservation-id"),
        amountSats: parsePositiveInteger(requireOption(args, "amount-sats"), "--amount-sats"),
        reason: requireOption(args, "reason"),
        createdAt
      }
    });

    writeJson(io, {
      command: "company.treasury.reserve",
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleCompanyTreasuryRelease(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const companyDid = requireOption(args, "company-did");

  await withCliContext(dataDir, async (context) => {
    const result = await appendEnvelope(context, {
      objectKind: "company",
      objectId: companyDid,
      eventKind: "company.treasury-released",
      subjectId: companyDid,
      payload: {
        reservationId: requireOption(args, "reservation-id")
      }
    });

    writeJson(io, {
      command: "company.treasury.release",
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleMarketProductCreate(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");

  await withCliContext(dataDir, async (context) => {
    const issuedAt = now();
    const description = getOptionalOption(args, "description");
    const payload = {
      marketplaceId: requireOption(args, "marketplace"),
      ownerDid: getOptionalOption(args, "owner-did") ?? context.identityMaterial.agentIdentity.did,
      title: requireOption(args, "title"),
      ...(description ? { description } : {})
    };
    const objectId = getOptionalOption(args, "id") ?? defaultObjectId("product", toProtocolValue({
      actorDid: context.identityMaterial.agentIdentity.did,
      issuedAt,
      payload: toProtocolJsonObject(payload)
    }));
    const result = await appendEnvelope(context, {
      objectKind: "product",
      objectId,
      eventKind: "product.created",
      subjectId: objectId,
      payload: toProtocolJsonObject(payload),
      issuedAt
    });

    writeJson(io, {
      command: "market.product.create",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleMarketProductUpdate(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const objectId = requireOption(args, "id");
  const title = getOptionalOption(args, "title");
  const description = getOptionalOption(args, "description");
  if (title === undefined && description === undefined) {
    throw new Error("At least one of --title or --description is required");
  }

  await withCliContext(dataDir, async (context) => {
    const result = await appendEnvelope(context, {
      objectKind: "product",
      objectId,
      eventKind: "product.updated",
      subjectId: objectId,
      payload: toProtocolJsonObject({
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {})
      })
    });

    writeJson(io, {
      command: "market.product.update",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleMarketProductStateChange(
  args: ParsedArgs,
  io: CliIo,
  eventKind: "product.published" | "product.unpublished" | "product.retired"
): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const objectId = requireOption(args, "id");

  await withCliContext(dataDir, async (context) => {
    const result = await appendEnvelope(context, {
      objectKind: "product",
      objectId,
      eventKind,
      subjectId: objectId,
      payload: {}
    });

    writeJson(io, {
      command: `market.product.${eventKind.split(".")[1]}`,
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleMarketListingPublish(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");

  await withCliContext(dataDir, async (context) => {
    const issuedAt = now();
    const productId = getOptionalOption(args, "product-id");
    const payload = {
      marketplaceId: requireOption(args, "marketplace"),
      sellerDid: getOptionalOption(args, "seller-did") ?? context.identityMaterial.agentIdentity.did,
      title: requireOption(args, "title"),
      ...(productId ? { productId } : {}),
      paymentTerms: parsePaymentTerms(args)
    };
    const objectId = getOptionalOption(args, "id") ?? defaultObjectId("listing", toProtocolValue({
      actorDid: context.identityMaterial.agentIdentity.did,
      issuedAt,
      payload: toProtocolJsonObject(payload)
    }));

    const result = await appendEnvelope(context, {
      objectKind: "listing",
      objectId,
      eventKind: "listing.published",
      subjectId: objectId,
      payload: toProtocolJsonObject(payload),
      issuedAt
    });

    writeJson(io, {
      command: "market.listing.publish",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleMarketListingRevise(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const objectId = requireOption(args, "id");

  await withCliContext(dataDir, async (context) => {
    const state = await readRequiredState<Protocol.ListingState>(context.repository, "listing", objectId);
    const title = getOptionalOption(args, "title");
    const paymentTerms = mergePaymentTerms(args, state.paymentTerms);
    const result = await appendEnvelope(context, {
      objectKind: "listing",
      objectId,
      eventKind: "listing.revised",
      subjectId: objectId,
      payload: toProtocolJsonObject({
        ...(title !== undefined ? { title } : {}),
        paymentTerms
      })
    });

    writeJson(io, {
      command: "market.listing.revise",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleSimpleMarketStateChange(
  args: ParsedArgs,
  io: CliIo,
  objectKind: "listing" | "request" | "offer" | "bid" | "agreement",
  eventKind: string
): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const objectId = requireOption(args, "id");

  await withCliContext(dataDir, async (context) => {
    const result = await appendEnvelope(context, {
      objectKind,
      objectId,
      eventKind,
      subjectId: objectId,
      payload: {}
    });

    writeJson(io, {
      command: `market.${objectKind}.${eventKind.split(".")[1]}`,
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleMarketRequestPublish(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");

  await withCliContext(dataDir, async (context) => {
    const issuedAt = now();
    const payload = {
      marketplaceId: requireOption(args, "marketplace"),
      requesterDid: getOptionalOption(args, "requester-did") ?? context.identityMaterial.agentIdentity.did,
      title: requireOption(args, "title"),
      paymentTerms: parsePaymentTerms(args)
    };
    const objectId = getOptionalOption(args, "id") ?? defaultObjectId("request", toProtocolValue({
      actorDid: context.identityMaterial.agentIdentity.did,
      issuedAt,
      payload: toProtocolJsonObject(payload)
    }));
    const result = await appendEnvelope(context, {
      objectKind: "request",
      objectId,
      eventKind: "request.published",
      subjectId: objectId,
      payload: toProtocolJsonObject(payload),
      issuedAt
    });

    writeJson(io, {
      command: "market.request.publish",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleMarketRequestRevise(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const objectId = requireOption(args, "id");

  await withCliContext(dataDir, async (context) => {
    const state = await readRequiredState<Protocol.RequestState>(context.repository, "request", objectId);
    const title = getOptionalOption(args, "title");
    const paymentTerms = mergePaymentTerms(args, state.paymentTerms);
    const result = await appendEnvelope(context, {
      objectKind: "request",
      objectId,
      eventKind: "request.revised",
      subjectId: objectId,
      payload: toProtocolJsonObject({
        ...(title !== undefined ? { title } : {}),
        paymentTerms
      })
    });

    writeJson(io, {
      command: "market.request.revise",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleMarketOfferSubmit(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");

  await withCliContext(dataDir, async (context) => {
    const issuedAt = now();
    const targetObjectId = getOptionalOption(args, "target-object-id");
    const lightningRefs = parseLightningRefs(args);
    const payload = {
      marketplaceId: requireOption(args, "marketplace"),
      proposerDid: getOptionalOption(args, "proposer-did") ?? context.identityMaterial.agentIdentity.did,
      ...(targetObjectId ? { targetObjectId } : {}),
      paymentTerms: parsePaymentTerms(args),
      ...(lightningRefs.length > 0 ? { lightningRefs } : {})
    };
    const objectId = getOptionalOption(args, "id") ?? defaultObjectId("offer", toProtocolValue({
      actorDid: context.identityMaterial.agentIdentity.did,
      issuedAt,
      payload: toProtocolJsonObject(payload)
    }));
    const result = await appendEnvelope(context, {
      objectKind: "offer",
      objectId,
      eventKind: "offer.submitted",
      subjectId: objectId,
      payload: toProtocolJsonObject(payload),
      issuedAt
    });

    writeJson(io, {
      command: "market.offer.submit",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleMarketOfferCounter(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const objectId = requireOption(args, "id");

  await withCliContext(dataDir, async (context) => {
    const state = await readRequiredState<Protocol.OfferState>(context.repository, "offer", objectId);
    const lightningRefs = parseLightningRefs(args);
    const result = await appendEnvelope(context, {
      objectKind: "offer",
      objectId,
      eventKind: "offer.countered",
      subjectId: objectId,
      payload: toProtocolJsonObject({
        paymentTerms: mergePaymentTerms(args, state.paymentTerms),
        ...(lightningRefs.length > 0 ? { lightningRefs } : {})
      })
    });

    writeJson(io, {
      command: "market.offer.counter",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleMarketBidSubmit(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");

  await withCliContext(dataDir, async (context) => {
    const issuedAt = now();
    const targetObjectId = getOptionalOption(args, "target-object-id");
    const lightningRefs = parseLightningRefs(args);
    const payload = {
      marketplaceId: requireOption(args, "marketplace"),
      proposerDid: getOptionalOption(args, "proposer-did") ?? context.identityMaterial.agentIdentity.did,
      ...(targetObjectId ? { targetObjectId } : {}),
      paymentTerms: parsePaymentTerms(args),
      ...(lightningRefs.length > 0 ? { lightningRefs } : {})
    };
    const objectId = getOptionalOption(args, "id") ?? defaultObjectId("bid", toProtocolValue({
      actorDid: context.identityMaterial.agentIdentity.did,
      issuedAt,
      payload: toProtocolJsonObject(payload)
    }));
    const result = await appendEnvelope(context, {
      objectKind: "bid",
      objectId,
      eventKind: "bid.submitted",
      subjectId: objectId,
      payload: toProtocolJsonObject(payload),
      issuedAt
    });

    writeJson(io, {
      command: "market.bid.submit",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleMarketBidCounter(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const objectId = requireOption(args, "id");

  await withCliContext(dataDir, async (context) => {
    const state = await readRequiredState<Protocol.BidState>(context.repository, "bid", objectId);
    const lightningRefs = parseLightningRefs(args);
    const result = await appendEnvelope(context, {
      objectKind: "bid",
      objectId,
      eventKind: "bid.countered",
      subjectId: objectId,
      payload: toProtocolJsonObject({
        paymentTerms: mergePaymentTerms(args, state.paymentTerms),
        ...(lightningRefs.length > 0 ? { lightningRefs } : {})
      })
    });

    writeJson(io, {
      command: "market.bid.counter",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

function deriveAgreementCounterparties(
  sourceKind: "offer" | "bid" | "listing" | "request",
  sourceState: Protocol.OfferState | Protocol.BidState | Protocol.ListingState | Protocol.RequestState,
  actorDid: string,
  explicitCounterparties: string[]
): string[] {
  if (explicitCounterparties.length > 0) {
    return [...new Set(explicitCounterparties)].sort();
  }

  switch (sourceKind) {
    case "offer":
      return [...new Set([(sourceState as Protocol.OfferState).proposerDid, actorDid])].sort();
    case "bid":
      return [...new Set([(sourceState as Protocol.BidState).proposerDid, actorDid])].sort();
    case "listing":
      return [...new Set([(sourceState as Protocol.ListingState).sellerDid, actorDid])].sort();
    case "request":
      return [...new Set([(sourceState as Protocol.RequestState).requesterDid, actorDid])].sort();
  }
}

async function handleMarketAgreementCreate(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const sourceKind = parseEnum(requireOption(args, "source-kind"), "--source-kind", [
    "offer",
    "bid",
    "listing",
    "request"
  ] as const);
  const sourceObjectId = requireOption(args, "source-id");

  await withCliContext(dataDir, async (context) => {
    const issuedAt = now();
    const sourceState = await readRequiredState<
      Protocol.OfferState | Protocol.BidState | Protocol.ListingState | Protocol.RequestState
    >(context.repository, sourceKind, sourceObjectId);
    const marketplaceId = getOptionalOption(args, "marketplace") ?? sourceState.marketplaceId;
    const paymentTerms =
      getOptionalOption(args, "amount-sats") || getOptionalOption(args, "currency") || getOptionalOption(args, "settlement")
        ? mergePaymentTerms(args, sourceState.paymentTerms)
        : sourceState.paymentTerms;
    const deliverables = getCsvOptionValues(args, "deliverable");
    if (deliverables.length === 0) {
      throw new Error("At least one --deliverable is required");
    }
    const counterparties = deriveAgreementCounterparties(
      sourceKind,
      sourceState,
      context.identityMaterial.agentIdentity.did,
      getCsvOptionValues(args, "counterparty")
    );
    const lightningRefs = parseLightningRefs(args);
    const payload = {
      marketplaceId,
      sourceObjectKind: sourceKind,
      sourceObjectId,
      counterparties,
      deliverables,
      paymentTerms,
      ...(lightningRefs.length > 0 ? { lightningRefs } : {})
    };
    const objectId = getOptionalOption(args, "id") ?? defaultObjectId("agreement", toProtocolValue({
      actorDid: context.identityMaterial.agentIdentity.did,
      issuedAt,
      payload: toProtocolJsonObject(payload)
    }));

    const result = await appendEnvelope(context, {
      objectKind: "agreement",
      objectId,
      eventKind: "agreement.created",
      subjectId: objectId,
      payload: toProtocolJsonObject(payload),
      issuedAt
    });

    writeJson(io, {
      command: "market.agreement.create",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleContractCreate(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");

  await withCliContext(dataDir, async (context) => {
    const issuedAt = now();
    const sponsorDid = getOptionalOption(args, "sponsor-did");
    const companyDid = getOptionalOption(args, "company-did");
    const payload: Protocol.ContractCreatedPayload = {
      originRef: {
        objectKind: parseEnum(requireOption(args, "origin-kind"), "--origin-kind", [
          "agreement",
          "listing",
          "request",
          "offer",
          "bid"
        ] as const),
        objectId: requireOption(args, "origin-id")
      },
      parties: getCsvOptionValues(args, "party"),
      ...(sponsorDid ? { sponsorDid } : {}),
      ...(companyDid ? { companyDid } : {}),
      scope: requireOption(args, "scope"),
      milestones: parseJsonOption<Protocol.MilestoneDefinition[]>(args, "milestones-json"),
      deliverableSchema: parseJsonOption<Protocol.DeliverableSchema>(args, "deliverable-schema-json"),
      proofPolicy: parseJsonOption<Protocol.ProofPolicy>(args, "proof-policy-json"),
      resolutionPolicy: parseJsonOption<Protocol.ResolutionPolicy>(args, "resolution-policy-json"),
      settlementPolicy: parseJsonOption<Protocol.SettlementPolicy>(args, "settlement-policy-json"),
      deadlinePolicy: parseJsonOption<Protocol.DeadlinePolicy>(args, "deadline-policy-json")
    };
    if (payload.parties.length === 0) {
      throw new Error("At least one --party is required");
    }
    const objectId = getOptionalOption(args, "id") ?? defaultObjectId("contract", toProtocolValue({
      actorDid: context.identityMaterial.agentIdentity.did,
      issuedAt,
      payload: toProtocolJsonObject(payload)
    }));
    const result = await appendEnvelope(context, {
      objectKind: "contract",
      objectId,
      eventKind: "contract.created",
      subjectId: objectId,
      payload: Protocol.contractCreatedPayloadToJson(payload),
      issuedAt
    });

    writeJson(io, {
      command: "contract.create",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleContractMilestoneAction(
  args: ParsedArgs,
  io: CliIo,
  eventKind:
    | "contract.milestone-opened"
    | "contract.milestone-submitted"
    | "contract.milestone-accepted"
    | "contract.milestone-rejected"
): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const contractId = requireOption(args, "id");
  const milestoneId = requireOption(args, "milestone-id");

  await withCliContext(dataDir, async (context) => {
    const payload =
      eventKind === "contract.milestone-opened"
        ? { milestoneId }
        : eventKind === "contract.milestone-rejected"
          ? { milestoneId, reason: requireOption(args, "reason") }
          : {
              milestoneId,
              ...(getUniqueOptionValues(args, "evidence-bundle-id").length > 0
                ? { evidenceBundleIds: getUniqueOptionValues(args, "evidence-bundle-id") }
                : {}),
              ...(getUniqueOptionValues(args, "oracle-attestation-id").length > 0
                ? { oracleAttestationIds: getUniqueOptionValues(args, "oracle-attestation-id") }
                : {})
            };
    const result = await appendEnvelope(context, {
      objectKind: "contract",
      objectId: contractId,
      eventKind,
      subjectId: contractId,
      payload: toProtocolJsonObject(payload)
    });

    writeJson(io, {
      command: `contract.${eventKind.split(".")[1]}`,
      objectId: contractId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleContractStateChange(
  args: ParsedArgs,
  io: CliIo,
  eventKind: "contract.paused" | "contract.resumed" | "contract.completed" | "contract.canceled" | "contract.disputed"
): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const contractId = requireOption(args, "id");

  await withCliContext(dataDir, async (context) => {
    const result = await appendEnvelope(context, {
      objectKind: "contract",
      objectId: contractId,
      eventKind,
      subjectId: contractId,
      payload: {}
    });

    writeJson(io, {
      command: `contract.${eventKind.split(".")[1]}`,
      objectId: contractId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleEvidenceRecord(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");

  await withCliContext(dataDir, async (context) => {
    const issuedAt = now();
    const artifactRefs = getOptionalOption(args, "artifact-json")
      ? parseJsonOption<Protocol.ArtifactRef[]>(args, "artifact-json")
      : [];
    const verifierRefs = getOptionalOption(args, "verifier-json")
      ? parseJsonOption<Protocol.VerifierRef[]>(args, "verifier-json")
      : [];
    const reproInstructions = getOptionalOption(args, "repro");
    const executionTranscriptRefs = getUniqueOptionValues(args, "execution-transcript-ref");
    const hashes = Object.fromEntries(
      getUniqueOptionValues(args, "hash").map((entry) => {
        const [name, hash] = entry.split("=", 2);
        if (!name || !hash) {
          throw new Error("--hash must use <name>=<hex-hash>");
        }
        return [name, hash];
      })
    );
    const payload = {
      contractId: requireOption(args, "contract-id"),
      milestoneId: requireOption(args, "milestone-id"),
      submitterDid: context.identityMaterial.agentIdentity.did,
      artifactRefs,
      verifierRefs,
      proofModes: getCsvOptionValues(args, "proof-mode") as Protocol.ProofMode[],
      ...(reproInstructions ? { reproInstructions } : {}),
      hashes,
      executionTranscriptRefs
    };
    const objectId = getOptionalOption(args, "id") ?? defaultObjectId("evidence-bundle", toProtocolValue({
      actorDid: context.identityMaterial.agentIdentity.did,
      issuedAt,
      payload: toProtocolJsonObject(payload)
    }));
    const result = await appendEnvelope(context, {
      objectKind: "evidence-bundle",
      objectId,
      eventKind: "evidence-bundle.recorded",
      subjectId: objectId,
      payload: Protocol.evidenceBundlePayloadToJson(payload),
      issuedAt
    });

    writeJson(io, {
      command: "evidence.record",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleOracleAttest(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");

  await withCliContext(dataDir, async (context) => {
    const issuedAt = getOptionalOption(args, "issued-at") ?? now();
    const milestoneId = getOptionalOption(args, "milestone-id");
    const payload = {
      oracleDid: context.identityMaterial.agentIdentity.did,
      claimType: requireOption(args, "claim-type"),
      subjectRef: {
        objectKind: parseEnum(requireOption(args, "subject-kind"), "--subject-kind", [
          "contract",
          "evidence-bundle",
          "dispute-case"
        ] as const),
        objectId: requireOption(args, "subject-id"),
        ...(milestoneId ? { milestoneId } : {})
      },
      outcome: parseEnum(requireOption(args, "outcome"), "--outcome", [
        "satisfied",
        "unsatisfied",
        "accepted",
        "rejected",
        "completed",
        "breached"
      ] as const),
      evidenceRefs: getUniqueOptionValues(args, "evidence-ref"),
      issuedAt,
      expiresAt: requireOption(args, "expires-at")
    };
    const objectId = getOptionalOption(args, "id") ?? defaultObjectId("oracle-attestation", toProtocolValue({
      actorDid: context.identityMaterial.agentIdentity.did,
      issuedAt,
      payload: toProtocolJsonObject(payload)
    }));
    const result = await appendEnvelope(context, {
      objectKind: "oracle-attestation",
      objectId,
      eventKind: "oracle-attestation.recorded",
      subjectId: objectId,
      payload: Protocol.oracleAttestationPayloadToJson(payload),
      issuedAt
    });

    writeJson(io, {
      command: "oracle.attest",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleDisputeOpen(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");

  await withCliContext(dataDir, async (context) => {
    const issuedAt = now();
    const payload = {
      contractId: requireOption(args, "contract-id"),
      ...(getOptionalOption(args, "milestone-id") ? { milestoneId: getOptionalOption(args, "milestone-id") } : {}),
      reason: requireOption(args, "reason")
    };
    const objectId = getOptionalOption(args, "id") ?? defaultObjectId("dispute-case", toProtocolValue({
      actorDid: context.identityMaterial.agentIdentity.did,
      issuedAt,
      payload: toProtocolJsonObject(payload)
    }));
    const result = await appendEnvelope(context, {
      objectKind: "dispute-case",
      objectId,
      eventKind: "dispute.opened",
      subjectId: objectId,
      payload: toProtocolJsonObject(payload),
      issuedAt
    });

    writeJson(io, {
      command: "dispute.open",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleDisputeAddEvidence(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const objectId = requireOption(args, "id");

  await withCliContext(dataDir, async (context) => {
    const evidenceBundleIds = getUniqueOptionValues(args, "evidence-bundle-id");
    if (evidenceBundleIds.length === 0) {
      throw new Error("At least one --evidence-bundle-id is required");
    }
    const result = await appendEnvelope(context, {
      objectKind: "dispute-case",
      objectId,
      eventKind: "dispute.evidence-added",
      subjectId: objectId,
      payload: {
        evidenceBundleIds
      }
    });

    writeJson(io, {
      command: "dispute.add-evidence",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleDisputeRequestOracle(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const objectId = requireOption(args, "id");

  await withCliContext(dataDir, async (context) => {
    const result = await appendEnvelope(context, {
      objectKind: "dispute-case",
      objectId,
      eventKind: "dispute.oracle-requested",
      subjectId: objectId,
      payload: {}
    });

    writeJson(io, {
      command: "dispute.request-oracle",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleDisputeRule(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const objectId = requireOption(args, "id");

  await withCliContext(dataDir, async (context) => {
    const deterministicVerifierId = getOptionalOption(args, "deterministic-verifier-id");
    const summary = getOptionalOption(args, "summary");
    const ruling: Protocol.DisputeRuling = {
      outcome: parseEnum(requireOption(args, "outcome"), "--outcome", [
        "fulfilled",
        "breach",
        "refund",
        "partial",
        "rejected-claim"
      ] as const),
      resolutionMode: parseEnum(requireOption(args, "resolution-mode"), "--resolution-mode", [
        "deterministic",
        "oracle",
        "mutual",
        "hybrid"
      ] as const),
      ...(deterministicVerifierId ? { deterministicVerifierId } : {}),
      oracleAttestationIds: getUniqueOptionValues(args, "oracle-attestation-id"),
      evidenceBundleIds: getUniqueOptionValues(args, "evidence-bundle-id"),
      approverDids: getCsvOptionValues(args, "approver"),
      ...(summary ? { summary } : {})
    };
    const result = await appendEnvelope(context, {
      objectKind: "dispute-case",
      objectId,
      eventKind: "dispute.ruled",
      subjectId: objectId,
      payload: Protocol.disputeRulingToJson(ruling)
    });

    writeJson(io, {
      command: "dispute.rule",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleDisputeClose(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const objectId = requireOption(args, "id");

  await withCliContext(dataDir, async (context) => {
    const result = await appendEnvelope(context, {
      objectKind: "dispute-case",
      objectId,
      eventKind: "dispute.closed",
      subjectId: objectId,
      payload: {}
    });

    writeJson(io, {
      command: "dispute.close",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleSpaceCreate(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");

  await withCliContext(dataDir, async (context) => {
    const issuedAt = now();
    const spaceId = getOptionalOption(args, "id") ?? defaultObjectId("space", toProtocolValue({
      actorDid: context.identityMaterial.agentIdentity.did,
      issuedAt,
      ownerRef: {
        kind: requireOption(args, "owner-kind"),
        id: requireOption(args, "owner-id")
      }
    }));
    const membershipPolicy = getOptionalOption(args, "membership-policy-json")
      ? parseJsonOption<Protocol.MembershipPolicy>(args, "membership-policy-json")
      : {
          mode: "invite-only" as const,
          ownerMemberDids: [context.identityMaterial.agentIdentity.did]
        };
    const encryptionPolicy = getOptionalOption(args, "encryption-policy-json")
      ? parseJsonOption<Protocol.EncryptionPolicy>(args, "encryption-policy-json")
      : {
          mode: "member-sealed-box" as const,
          keyAgreementMethod: "did-keyagreement-v1" as const
        };
    const payload = {
      spaceKind: parseEnum(requireOption(args, "space-kind"), "--space-kind", [
        "direct-inbox",
        "contract-thread",
        "company-room",
        "market-room"
      ] as const),
      ownerRef: {
        kind: parseEnum(requireOption(args, "owner-kind"), "--owner-kind", [
          "agent",
          "company",
          "marketplace",
          "contract",
          "dispute"
        ] as const),
        id: requireOption(args, "owner-id")
      },
      membershipPolicy,
      encryptionPolicy
    };
    const created = await appendEnvelope(context, {
      objectKind: "space",
      objectId: spaceId,
      eventKind: "space.created",
      subjectId: spaceId,
      payload: Protocol.spacePayloadToJson(payload),
      issuedAt
    });
    const membershipObjectId = `${spaceId}:${context.identityMaterial.agentIdentity.did}`;
    await appendEnvelope(context, {
      objectKind: "space-membership",
      objectId: membershipObjectId,
      eventKind: "space-membership.member-added",
      subjectId: membershipObjectId,
      payload: Protocol.spaceMembershipPayloadToJson({
        spaceId,
        memberDid: context.identityMaterial.agentIdentity.did,
        role: "owner"
      })
    });

    writeJson(io, {
      command: "space.create",
      objectId: spaceId,
      eventId: created.envelope.eventId,
      state: created.state
    });
  });
}

async function handleSpaceMembershipAction(
  args: ParsedArgs,
  io: CliIo,
  eventKind:
    | "space-membership.member-added"
    | "space-membership.member-removed"
    | "space-membership.member-muted"
    | "space-membership.member-role-updated"
): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const spaceId = requireOption(args, "space-id");
  const memberDid = requireOption(args, "member-did");
  const objectId = getOptionalOption(args, "id") ?? `${spaceId}:${memberDid}`;

  await withCliContext(dataDir, async (context) => {
    const payload =
      eventKind === "space-membership.member-added"
        ? Protocol.spaceMembershipPayloadToJson({
            spaceId,
            memberDid,
            role: parseEnum(getOptionalOption(args, "role") ?? "member", "--role", [
              "owner",
              "moderator",
              "member"
            ] as const)
          })
        : eventKind === "space-membership.member-role-updated"
          ? toProtocolJsonObject({
              role: parseEnum(requireOption(args, "role"), "--role", ["owner", "moderator", "member"] as const)
            })
          : {};
    const result = await appendEnvelope(context, {
      objectKind: "space-membership",
      objectId,
      eventKind,
      subjectId: objectId,
      payload
    });

    writeJson(io, {
      command: `space.${eventKind.split(".")[1]}`,
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleMessageSend(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");

  await withCliContext(dataDir, async (context) => {
    const issuedAt = now();
    const spaceId = requireOption(args, "space-id");
    const activeMemberDids = listActiveSpaceMemberDids(context, spaceId);
    if (activeMemberDids.length === 0) {
      throw new Error("The target space has no active members");
    }
    const encryptedBody = await Protocol.encryptMessageForRecipients({
      plaintext: requireOption(args, "body"),
      senderDid: context.identityMaterial.agentIdentity.did,
      senderKeyAgreementPublicKey: context.identityMaterial.agentIdentity.keyAgreementPublicKey,
      senderKeyAgreementSecretKey: context.identityMaterial.keyAgreementKeyPair.secretKey,
      recipientDids: activeMemberDids
    });
    const payload = {
      spaceId,
      messageType: getOptionalOption(args, "message-type") ?? "text",
      metadata: getOptionalOption(args, "metadata-json")
        ? parseJsonOption<Protocol.ProtocolJsonObject>(args, "metadata-json")
        : {},
      encryptedBody,
      sentAt: issuedAt
    };
    const objectId = getOptionalOption(args, "id") ?? defaultObjectId("message", toProtocolValue({
      actorDid: context.identityMaterial.agentIdentity.did,
      issuedAt,
      payload: toProtocolJsonObject(payload)
    }));
    const result = await appendEnvelope(context, {
      objectKind: "message",
      objectId,
      eventKind: "message.sent",
      subjectId: objectId,
      payload: Protocol.messageSentPayloadToJson(payload),
      issuedAt
    });

    writeJson(io, {
      command: "message.send",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleMessageEdit(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const objectId = requireOption(args, "id");

  await withCliContext(dataDir, async (context) => {
    const current = await readRequiredState<Protocol.MessageState>(context.repository, "message", objectId);
    const activeMemberDids = listActiveSpaceMemberDids(context, current.spaceId);
    const encryptedBody = await Protocol.encryptMessageForRecipients({
      plaintext: requireOption(args, "body"),
      senderDid: context.identityMaterial.agentIdentity.did,
      senderKeyAgreementPublicKey: context.identityMaterial.agentIdentity.keyAgreementPublicKey,
      senderKeyAgreementSecretKey: context.identityMaterial.keyAgreementKeyPair.secretKey,
      recipientDids: activeMemberDids
    });
    const result = await appendEnvelope(context, {
      objectKind: "message",
      objectId,
      eventKind: "message.edited",
      subjectId: objectId,
      payload: Protocol.messageSentPayloadToJson({
        spaceId: current.spaceId,
        messageType: current.messageType,
        metadata: getOptionalOption(args, "metadata-json")
          ? parseJsonOption<Protocol.ProtocolJsonObject>(args, "metadata-json")
          : current.metadata,
        encryptedBody
      })
    });

    writeJson(io, {
      command: "message.edit",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleMessageDelete(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const objectId = requireOption(args, "id");

  await withCliContext(dataDir, async (context) => {
    const result = await appendEnvelope(context, {
      objectKind: "message",
      objectId,
      eventKind: "message.deleted",
      subjectId: objectId,
      payload: {}
    });

    writeJson(io, {
      command: "message.delete",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleMessageReact(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const objectId = requireOption(args, "id");

  await withCliContext(dataDir, async (context) => {
    const result = await appendEnvelope(context, {
      objectKind: "message",
      objectId,
      eventKind: "message.reacted",
      subjectId: objectId,
      payload: {
        reaction: requireOption(args, "reaction")
      }
    });

    writeJson(io, {
      command: "message.react",
      objectId,
      eventId: result.envelope.eventId,
      state: result.state
    });
  });
}

async function handleContractEntries(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const contractId = requireOption(args, "id");

  await withCliContext(dataDir, async (context) => {
    writeJson(io, {
      command: "contract.entries",
      contractId,
      entries: await context.repository.listContractEntries(contractId)
    });
  });
}

async function handleSpaceEntries(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const spaceId = requireOption(args, "space-id");

  await withCliContext(dataDir, async (context) => {
    writeJson(io, {
      command: "space.entries",
      spaceId,
      entries: await context.repository.listSpaceEntries(spaceId)
    });
  });
}

async function handleObjectShow(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const kind = parseEnum(requireOption(args, "kind"), "--kind", [
    "agent-profile",
    "company",
    "product",
    "listing",
    "request",
    "offer",
    "bid",
    "agreement",
    "feedback-credential-ref",
    "contract",
    "evidence-bundle",
    "oracle-attestation",
    "dispute-case",
    "space",
    "space-membership",
    "message"
  ] as const);
  const objectId = requireOption(args, "id");

  await withCliContext(dataDir, async (context) => {
    writeJson(io, {
      command: "object.show",
      kind,
      objectId,
      state: await context.repository.readObjectState(kind, objectId)
    });
  });
}

async function handleMarketList(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const marketplaceId = requireOption(args, "marketplace");

  await withCliContext(dataDir, async (context) => {
    writeJson(io, {
      command: "market.list",
      marketplaceId,
      entries: await context.repository.listMarketplaceEntries(marketplaceId)
    });
  });
}

async function handleContextAdd(args: ParsedArgs, io: CliIo): Promise<void> {
  const name = requireOption(args, "name");
  const dataDir = requireOption(args, "data-dir");
  const makeActive = hasFlag(args, "make-active");
  const store = new ContextStore();
  const snapshot = await store.add(name, dataDir, makeActive);
  writeJson(io, {
    command: "context.add",
    activeContext: snapshot.activeContext,
    contexts: snapshot.contexts
  });
}

async function handleContextUse(args: ParsedArgs, io: CliIo): Promise<void> {
  const name = requireOption(args, "name");
  const store = new ContextStore();
  const snapshot = await store.use(name);
  writeJson(io, {
    command: "context.use",
    activeContext: snapshot.activeContext,
    contexts: snapshot.contexts
  });
}

async function handleContextList(io: CliIo): Promise<void> {
  const store = new ContextStore();
  const snapshot = await store.snapshot();
  writeJson(io, {
    command: "context.list",
    activeContext: snapshot.activeContext,
    contexts: snapshot.contexts
  });
}

async function handleContextShow(io: CliIo): Promise<void> {
  const store = new ContextStore();
  const snapshot = await store.snapshot();
  const active = snapshot.activeContext
    ? snapshot.contexts.find((entry) => entry.name === snapshot.activeContext)
    : undefined;
  writeJson(io, {
    command: "context.show",
    activeContext: snapshot.activeContext,
    active: active ?? null
  });
}

async function handleContextRemove(args: ParsedArgs, io: CliIo): Promise<void> {
  const name = requireOption(args, "name");
  const store = new ContextStore();
  const snapshot = await store.remove(name);
  writeJson(io, {
    command: "context.remove",
    activeContext: snapshot.activeContext,
    contexts: snapshot.contexts
  });
}

function applyWalletRuntimeKeyFromArgs(context: CliContext, args: ParsedArgs): void {
  const walletKey = getOptionalOption(args, "wallet-key");
  if (walletKey && walletKey.trim().length > 0) {
    context.walletService.setRuntimeKey(walletKey);
  }
}

async function handleWalletConnectNwc(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const connectionUri = requireOption(args, "connection-uri");
  const publishEndpoint = hasFlag(args, "publish-payment-endpoint");

  await withCliContext(dataDir, async (context) => {
    applyWalletRuntimeKeyFromArgs(context, args);
    const connected = await context.walletService.connect(connectionUri);
    let paymentEndpointEventId: string | undefined;

    if (publishEndpoint) {
      await ensureAgentProfileExists(context);
      const capabilities = getCsvOptionValues(args, "payment-capability");
      const accountId = getOptionalOption(args, "payment-account-id");
      const endpoint: Protocol.PaymentEndpoint = {
        id: getOptionalOption(args, "payment-endpoint-id") ?? "wallet-nwc",
        network: "bitcoin",
        custodial: true,
        capabilities: capabilities.length > 0 ? capabilities : ["invoice.create", "invoice.pay", "auto-settle"],
        ...(accountId ? { accountId } : {}),
        nodeUri: connected.endpoint
      };
      const result = await appendEnvelope(context, {
        objectKind: "agent-profile",
        objectId: context.identityMaterial.agentIdentity.did,
        eventKind: "agent-profile.payment-endpoint-added",
        subjectId: context.identityMaterial.agentIdentity.did,
        payload: Protocol.paymentEndpointToJson(endpoint)
      });
      paymentEndpointEventId = result.envelope.eventId;
    }

    writeJson(io, {
      command: "wallet.connect.nwc",
      wallet: connected.status,
      endpoint: connected.endpoint,
      ...(paymentEndpointEventId ? { paymentEndpointEventId } : {})
    });
  });
}

async function handleWalletConnectCircle(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const connectionUri = requireOption(args, "connection-uri");
  const publishEndpoint = hasFlag(args, "publish-payment-endpoint");
  if (publishEndpoint) {
    throw new Error("--publish-payment-endpoint is not yet supported for circle backend");
  }

  await withCliContext(dataDir, async (context) => {
    applyWalletRuntimeKeyFromArgs(context, args);
    const connected = await context.walletService.connect(connectionUri);
    writeJson(io, {
      command: "wallet.connect.circle",
      wallet: connected.status,
      endpoint: connected.endpoint
    });
  });
}

async function handleWalletDisconnect(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");

  await withCliContext(dataDir, async (context) => {
    applyWalletRuntimeKeyFromArgs(context, args);
    const wallet = await context.walletService.disconnect();
    writeJson(io, {
      command: "wallet.disconnect",
      wallet
    });
  });
}

async function handleWalletStatus(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");

  await withCliContext(dataDir, async (context) => {
    applyWalletRuntimeKeyFromArgs(context, args);
    writeJson(io, {
      command: "wallet.status",
      wallet: await context.walletService.status()
    });
  });
}

async function handleWalletUnlock(args: ParsedArgs, io: CliIo): Promise<void> {
  if (process.env.EMPORION_DAEMON !== "1") {
    throw new Error("wallet unlock requires a running daemon for this data-dir");
  }
  const dataDir = requireOption(args, "data-dir");
  const walletKey = requireOption(args, "wallet-key");
  if (walletKey.trim().length === 0) {
    throw new Error("--wallet-key must not be blank");
  }

  await withCliContext(dataDir, async (context) => {
    context.walletService.setRuntimeKey(walletKey);
    writeJson(io, {
      command: "wallet.unlock",
      wallet: await context.walletService.status()
    });
  });
}

async function handleWalletLock(args: ParsedArgs, io: CliIo): Promise<void> {
  if (process.env.EMPORION_DAEMON !== "1") {
    throw new Error("wallet lock requires a running daemon for this data-dir");
  }
  const dataDir = requireOption(args, "data-dir");
  await withCliContext(dataDir, async (context) => {
    context.walletService.setRuntimeKey(null);
    writeJson(io, {
      command: "wallet.lock",
      wallet: await context.walletService.status()
    });
  });
}

async function handleWalletInvoiceCreate(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const amountSats = parsePositiveInteger(requireOption(args, "amount-sats"), "--amount-sats");
  const memo = getOptionalOption(args, "memo");
  const expiresAt = parseOptionalIsoTimestamp(args, "expires-at");

  await withCliContext(dataDir, async (context) => {
    applyWalletRuntimeKeyFromArgs(context, args);
    const created = await context.walletService.createInvoice({
      amountSats,
      ...(memo ? { memo } : {}),
      ...(expiresAt ? { expiresAt } : {})
    });
    writeJson(io, {
      command: "wallet.invoice.create",
      invoice: created.invoice,
      bolt11: created.bolt11
    });
  });
}

async function handleWalletPayBolt11(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const invoice = requireOption(args, "invoice");
  const sourceRef = getOptionalOption(args, "source-ref");

  await withCliContext(dataDir, async (context) => {
    applyWalletRuntimeKeyFromArgs(context, args);
    const status = await context.walletService.status();
    if (status.connected && status.backend === "circle") {
      throw new Error("wallet pay bolt11 is not supported for circle backend; use wallet pay x402");
    }
    const paid = await context.walletService.payInvoice({
      invoice,
      ...(sourceRef ? { sourceRef } : {})
    });
    writeJson(io, {
      command: "wallet.pay.bolt11",
      payment: paid.payment
    });
  });
}

async function handleWalletPayX402(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const resource = requireOption(args, "resource");
  const sourceRef = getOptionalOption(args, "source-ref");

  await withCliContext(dataDir, async (context) => {
    applyWalletRuntimeKeyFromArgs(context, args);
    const status = await context.walletService.status();
    if (status.connected && status.backend !== "circle") {
      throw new Error("wallet pay x402 requires a circle backend connection");
    }
    const paid = await context.walletService.payInvoice({
      invoice: resource,
      ...(sourceRef ? { sourceRef } : {})
    });
    writeJson(io, {
      command: "wallet.pay.x402",
      payment: paid.payment
    });
  });
}

async function handleWalletLedgerList(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const kindValue = getOptionalOption(args, "kind");
  const status = getOptionalOption(args, "status");
  const kind = kindValue ? parseEnum(kindValue, "--kind", ["invoice", "payment"] as const) : undefined;

  await withCliContext(dataDir, async (context) => {
    applyWalletRuntimeKeyFromArgs(context, args);
    const filters = {
      ...(kind ? { kind } : {}),
      ...(status ? { status } : {})
    };
    writeJson(io, {
      command: "wallet.ledger.list",
      kind: kind ?? null,
      status: status ?? null,
      entries: await context.walletService.listLedger(filters)
    });
  });
}

async function handleWalletKeyRotate(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const newKey = requireOption(args, "new-key");

  await withCliContext(dataDir, async (context) => {
    applyWalletRuntimeKeyFromArgs(context, args);
    await context.walletService.rotateKey(newKey);
    writeJson(io, {
      command: "wallet.key.rotate",
      rotated: true
    });
  });
}

async function handleDealOpen(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const intent = parseEnum(requireOption(args, "intent"), "--intent", ["buy", "sell"] as const);
  const marketplaceId = requireOption(args, "marketplace");
  const title = requireOption(args, "title");
  const amountSats = parsePositiveInteger(requireOption(args, "amount-sats"), "--amount-sats");
  const dealId = getOptionalOption(args, "deal-id") ?? `deal:${randomUUID()}`;

  await withCliContext(dataDir, async () => {
    const deals = await DealsStore.create(dataDir);
    if (deals.get(dealId)) {
      throw new Error(`Deal already exists: ${dealId}`);
    }

    const created = await runNestedCommand(
      ["market", intent === "buy" ? "request" : "listing", "publish"],
      {
        "data-dir": dataDir,
        marketplace: marketplaceId,
        title,
        "amount-sats": `${amountSats}`
      }
    );
    const createdRecord = asRecord(created, `${intent}.publish result`);
    const objectId = readString(createdRecord.objectId, "objectId");

    const nowIso = now();
    const deal: DealRecord = {
      dealId,
      stage: "negotiating",
      intent,
      marketplaceId,
      title,
      amountSats,
      rootObjectKind: intent === "buy" ? "request" : "listing",
      rootObjectId: objectId,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    await deals.save(deal);
    writeDealResponse(io, "deal.open", deal);
  });
}

async function handleDealPropose(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const targetId = requireOption(args, "target-id");
  const amountSats = parsePositiveInteger(requireOption(args, "amount-sats"), "--amount-sats");
  const proposalId = getOptionalOption(args, "proposal-id");
  const proposerDid = getOptionalOption(args, "proposer-did");

  await withCliContext(dataDir, async (context) => {
    const rootObjectKind = inferRootObjectKindFromId(targetId);
    const deals = await DealsStore.create(dataDir);
    const targetState =
      rootObjectKind === "request"
        ? await readRequiredState<Protocol.RequestState>(context.repository, "request", targetId)
        : await readRequiredState<Protocol.ListingState>(context.repository, "listing", targetId);

    const proposalKind = rootObjectKind === "request" ? "offer" : "bid";
    const proposed = await runNestedCommand(
      ["market", proposalKind, "submit"],
      {
        "data-dir": dataDir,
        marketplace: targetState.marketplaceId,
        "target-object-id": targetId,
        "amount-sats": `${amountSats}`,
        ...(proposerDid ? { "proposer-did": proposerDid } : {}),
        ...(proposalId ? { id: proposalId } : {})
      }
    );
    const proposedRecord = asRecord(proposed, `${proposalKind}.submit result`);
    const resolvedProposalId = readString(proposedRecord.objectId, "objectId");

    const existing = deals.findByRootObjectId(targetId);
    const nowIso = now();
    const deal = existing
      ? await deals.update(existing.dealId, (current) => ({
          ...current,
          stage: "negotiating",
          proposalKind,
          proposalId: resolvedProposalId,
          amountSats,
          updatedAt: nowIso
        }))
      : await deals.save({
          dealId: `deal:${randomUUID()}`,
          stage: "negotiating",
          intent: inferIntentFromRootObjectKind(rootObjectKind),
          marketplaceId: targetState.marketplaceId,
          title: "proposal-only-deal",
          amountSats,
          rootObjectKind,
          rootObjectId: targetId,
          proposalKind,
          proposalId: resolvedProposalId,
          createdAt: nowIso,
          updatedAt: nowIso
        });

    writeDealResponse(io, "deal.propose", deal);
  });
}

async function handleDealAccept(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const proposalId = requireOption(args, "proposal-id");
  const proposalKind = inferProposalKindFromId(proposalId);

  await withCliContext(dataDir, async () => {
    const deals = await DealsStore.create(dataDir);
    await runNestedCommand(["market", proposalKind, "accept"], {
      "data-dir": dataDir,
      id: proposalId
    });

    const existing = deals.findByProposalId(proposalId);
    const nowIso = now();
    const deal = existing
      ? await deals.update(existing.dealId, (current) => ({
          ...current,
          stage: "agreed",
          proposalKind,
          proposalId,
          updatedAt: nowIso
        }))
      : await deals.save({
          dealId: `deal:${randomUUID()}`,
          stage: "agreed",
          proposalKind,
          proposalId,
          createdAt: nowIso,
          updatedAt: nowIso
        });

    writeDealResponse(io, "deal.accept", deal);
  });
}

async function handleDealStart(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const proposalId = requireOption(args, "proposal-id");
  const scope = requireOption(args, "scope");
  const milestoneId = requireOption(args, "milestone-id");
  const milestoneTitle = requireOption(args, "milestone-title");
  const deadline = parseOptionalIsoTimestamp(args, "deadline");
  if (!deadline) {
    throw new Error("--deadline is required");
  }
  const deliverableKind = parseEnum(requireOption(args, "deliverable-kind"), "--deliverable-kind", ["artifact", "generic", "oracle-claim"] as const);
  const requiredArtifactKinds = getCsvOptionValues(args, "required-artifact-kind");
  if (requiredArtifactKinds.length === 0) {
    throw new Error("--required-artifact-kind must include at least one value");
  }
  const proposalKind = inferProposalKindFromId(proposalId);

  await withCliContext(dataDir, async (context) => {
    const deals = await DealsStore.create(dataDir);
    const proposalState =
      proposalKind === "offer"
        ? await readRequiredState<Protocol.OfferState>(context.repository, "offer", proposalId)
        : await readRequiredState<Protocol.BidState>(context.repository, "bid", proposalId);
    if (proposalState.status !== "accepted") {
      throw new Error(`Proposal must be accepted before deal start: ${proposalId}`);
    }

    const agreement = await runNestedCommand(
      ["market", "agreement", "create"],
      {
        "data-dir": dataDir,
        "source-kind": proposalKind,
        "source-id": proposalId,
        deliverable: [milestoneTitle],
        counterparty: [context.identityMaterial.agentIdentity.did, proposalState.proposerDid],
        "amount-sats": `${proposalState.paymentTerms.amountSats}`
      }
    );
    const agreementRecord = asRecord(agreement, "agreement.create result");
    const agreementId = readString(agreementRecord.objectId, "objectId");

    const milestonesJson = JSON.stringify([{
      milestoneId,
      title: milestoneTitle,
      deliverableSchema: {
        kind: deliverableKind,
        requiredArtifactKinds
      },
      proofPolicy: {
        allowedModes: ["artifact-verifiable"],
        verifierRefs: [],
        minArtifacts: 1,
        requireCounterpartyAcceptance: true
      },
      settlementAdapters: []
    }]);

    const contract = await runNestedCommand(
      ["contract", "create"],
      {
        "data-dir": dataDir,
        "origin-kind": "agreement",
        "origin-id": agreementId,
        party: [context.identityMaterial.agentIdentity.did, proposalState.proposerDid],
        scope,
        "milestones-json": milestonesJson,
        "deliverable-schema-json": JSON.stringify({ kind: deliverableKind, requiredArtifactKinds }),
        "proof-policy-json": JSON.stringify({
          allowedModes: ["artifact-verifiable"],
          verifierRefs: [],
          minArtifacts: 1,
          requireCounterpartyAcceptance: true
        }),
        "resolution-policy-json": JSON.stringify({ mode: "mutual", deterministicVerifierIds: [] }),
        "settlement-policy-json": JSON.stringify({ adapters: [], releaseCondition: "contract-completed" }),
        "deadline-policy-json": JSON.stringify({ milestoneDeadlines: { [milestoneId]: deadline } })
      }
    );
    const contractRecord = asRecord(contract, "contract.create result");
    const contractId = readString(contractRecord.objectId, "objectId");

    await runNestedCommand(
      ["contract", "open-milestone"],
      {
        "data-dir": dataDir,
        id: contractId,
        "milestone-id": milestoneId
      }
    );

    const existing = deals.findByProposalId(proposalId);
    const nowIso = now();
    const deal = existing
      ? await deals.update(existing.dealId, (current) => ({
          ...current,
          stage: "in_progress",
          proposalKind,
          proposalId,
          agreementId,
          contractId,
          milestoneId,
          updatedAt: nowIso
        }))
      : await deals.save({
          dealId: `deal:${randomUUID()}`,
          stage: "in_progress",
          proposalKind,
          proposalId,
          agreementId,
          contractId,
          milestoneId,
          createdAt: nowIso,
          updatedAt: nowIso
        });

    writeDealResponse(io, "deal.start", deal);
  });
}

async function handleDealStatus(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const dealId = requireOption(args, "deal-id");

  const deals = await DealsStore.create(dataDir);
  const deal = deals.get(dealId);
  if (!deal) {
    throw new Error(`Unknown deal: ${dealId}`);
  }
  writeDealResponse(io, "deal.status", deal);
}

async function handleProofSubmit(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const dealId = requireOption(args, "deal-id");
  const milestoneId = requireOption(args, "milestone-id");
  const preset = parseEnum(requireOption(args, "proof-preset"), "--proof-preset", ["simple-artifact"] as const);
  if (preset !== "simple-artifact") {
    throw new Error(`Unsupported --proof-preset: ${preset}`);
  }
  const artifactId = requireOption(args, "artifact-id");
  const artifactHash = requireOption(args, "artifact-hash");
  const repro = getOptionalOption(args, "repro");

  await withCliContext(dataDir, async () => {
    const deals = await DealsStore.create(dataDir);
    const existing = deals.get(dealId);
    if (!existing) {
      throw new Error(`Unknown deal: ${dealId}`);
    }
    if (!existing.contractId) {
      throw new Error("Deal has no contract yet; run deal start first");
    }
    if (!stageAtLeast(existing.stage, "in_progress")) {
      throw new Error("Deal is not ready for proof submission");
    }

    const evidence = await runNestedCommand(
      ["evidence", "record"],
      {
        "data-dir": dataDir,
        "contract-id": existing.contractId,
        "milestone-id": milestoneId,
        "proof-mode": "artifact-verifiable",
        "artifact-json": JSON.stringify([{ artifactId, hash: artifactHash }]),
        "verifier-json": JSON.stringify([{ verifierId: "simple-artifact-check", verifierKind: "human-review" }]),
        ...(repro ? { repro } : {})
      }
    );
    const evidenceRecord = asRecord(evidence, "evidence.record result");
    const evidenceId = readString(evidenceRecord.objectId, "objectId");

    await runNestedCommand(
      ["contract", "submit-milestone"],
      {
        "data-dir": dataDir,
        id: existing.contractId,
        "milestone-id": milestoneId,
        "evidence-bundle-id": evidenceId
      }
    );

    const nowIso = now();
    const deal = await deals.update(dealId, (current) => ({
      ...current,
      stage: "proof_submitted",
      milestoneId,
      evidenceId,
      updatedAt: nowIso
    }));
    writeDealResponse(io, "proof.submit", deal);
  });
}

async function handleProofAccept(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const dealId = requireOption(args, "deal-id");
  const milestoneId = requireOption(args, "milestone-id");

  await withCliContext(dataDir, async () => {
    const deals = await DealsStore.create(dataDir);
    const existing = deals.get(dealId);
    if (!existing) {
      throw new Error(`Unknown deal: ${dealId}`);
    }
    if (!existing.contractId) {
      throw new Error("Deal has no contract yet");
    }
    if (!stageAtLeast(existing.stage, "proof_submitted")) {
      throw new Error("Deal proof must be submitted before acceptance");
    }

    await runNestedCommand(
      ["contract", "accept-milestone"],
      {
        "data-dir": dataDir,
        id: existing.contractId,
        "milestone-id": milestoneId
      }
    );
    const nowIso = now();
    const deal = await deals.update(dealId, (current) => ({
      ...current,
      stage: "proof_accepted",
      milestoneId,
      updatedAt: nowIso
    }));
    writeDealResponse(io, "proof.accept", deal);
  });
}

async function handleSettlementInvoiceCreate(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const dealId = requireOption(args, "deal-id");
  const amountSats = parsePositiveInteger(requireOption(args, "amount-sats"), "--amount-sats");
  const memo = getOptionalOption(args, "memo");
  const expiresAt = parseOptionalIsoTimestamp(args, "expires-at");
  const allowEarlySettlement = hasFlag(args, "allow-early-settlement");

  await withCliContext(dataDir, async (context) => {
    const deals = await DealsStore.create(dataDir);
    const existing = deals.get(dealId);
    if (!existing) {
      throw new Error(`Unknown deal: ${dealId}`);
    }
    if (!allowEarlySettlement && !stageAtLeast(existing.stage, "proof_accepted")) {
      throw new Error("Settlement invoice creation is proof-gated. Use --allow-early-settlement to override.");
    }

    applyWalletRuntimeKeyFromArgs(context, args);
    const created = await context.walletService.createInvoice({
      amountSats,
      ...(memo ? { memo } : {}),
      ...(expiresAt ? { expiresAt } : {})
    });
    const nowIso = now();
    const deal = await deals.update(dealId, (current) => ({
      ...current,
      stage: "settlement_pending",
      invoiceId: created.invoice.id,
      invoiceBolt11: created.bolt11,
      updatedAt: nowIso
    }));
    writeDealResponse(io, "settlement.invoice.create", deal, {
      safety: { earlySettlementAllowed: allowEarlySettlement }
    });
  });
}

async function handleSettlementPay(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const dealId = requireOption(args, "deal-id");
  const invoice = requireOption(args, "invoice");
  const allowEarlySettlement = hasFlag(args, "allow-early-settlement");

  await withCliContext(dataDir, async (context) => {
    const deals = await DealsStore.create(dataDir);
    const existing = deals.get(dealId);
    if (!existing) {
      throw new Error(`Unknown deal: ${dealId}`);
    }
    if (!allowEarlySettlement && !stageAtLeast(existing.stage, "proof_accepted")) {
      throw new Error("Settlement payment is proof-gated. Use --allow-early-settlement to override.");
    }
    applyWalletRuntimeKeyFromArgs(context, args);
    const sourceRef = existing.contractId
      ? `${existing.contractId}:${existing.milestoneId ?? "milestone"}`
      : dealId;
    const paid = await context.walletService.payInvoice({
      invoice,
      sourceRef
    });
    const nowIso = now();
    const deal = await deals.update(dealId, (current) => ({
      ...current,
      stage: "settled",
      paymentId: paid.payment.id,
      updatedAt: nowIso
    }));
    writeDealResponse(io, "settlement.pay", deal, {
      safety: { earlySettlementAllowed: allowEarlySettlement }
    });
  });
}

async function handleSettlementStatus(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const dealId = requireOption(args, "deal-id");

  const deals = await DealsStore.create(dataDir);
  const deal = deals.get(dealId);
  if (!deal) {
    throw new Error(`Unknown deal: ${dealId}`);
  }
  writeDealResponse(io, "settlement.status", deal);
}

function usage(): string {
  return [
    "Usage:",
    "  Global data-dir resolution: --data-dir <path> > --context <name> > active context",
    "  emporion context add --name <context> --data-dir <path> [--make-active]",
    "  emporion context use --name <context>",
    "  emporion context list",
    "  emporion context show",
    "  emporion context remove --name <context>",
    "  emporion agent init --data-dir <path> [--display-name <name>] [--bio <text>]",
    "  emporion agent show --data-dir <path>",
    "  emporion wallet connect nwc --data-dir <path> --connection-uri <uri> [--publish-payment-endpoint]",
    "  emporion wallet connect circle --data-dir <path> --connection-uri <uri>",
    "  emporion wallet disconnect --data-dir <path>",
    "  emporion wallet status --data-dir <path>",
    "  emporion wallet unlock [--data-dir <path>|--context <name>] --wallet-key <key-material>",
    "  emporion wallet lock [--data-dir <path>|--context <name>]",
    "  emporion wallet invoice create --data-dir <path> --amount-sats <n> [--memo <text>] [--expires-at <iso>]",
    "  emporion wallet pay bolt11 --data-dir <path> --invoice <bolt11>",
    "  emporion wallet pay x402 --data-dir <path> --resource <url-or-json>",
    "  emporion wallet ledger list --data-dir <path> [--kind <invoice|payment>] [--status <status>]",
    "  emporion wallet key rotate --data-dir <path> --new-key <key-material>",
    "  emporion deal open [--data-dir <path>|--context <name>] --intent <buy|sell> --marketplace <id> --title <text> --amount-sats <n> [--deal-id <id>]",
    "  emporion deal propose [--data-dir <path>|--context <name>] --target-id <object-id> --amount-sats <n> [--proposal-id <id>] [--proposer-did <did>]",
    "  emporion deal accept [--data-dir <path>|--context <name>] --proposal-id <offer-or-bid-id>",
    "  emporion deal start [--data-dir <path>|--context <name>] --proposal-id <offer-or-bid-id> --scope <text> --milestone-id <id> --milestone-title <text> --deadline <iso> --deliverable-kind <artifact|generic|oracle-claim> --required-artifact-kind <kind>[,<kind>...]",
    "  emporion deal status [--data-dir <path>|--context <name>] --deal-id <id>",
    "  emporion proof submit [--data-dir <path>|--context <name>] --deal-id <id> --milestone-id <id> --proof-preset <simple-artifact> --artifact-id <id> --artifact-hash <hex> [--repro <text>]",
    "  emporion proof accept [--data-dir <path>|--context <name>] --deal-id <id> --milestone-id <id>",
    "  emporion settlement invoice create [--data-dir <path>|--context <name>] --deal-id <id> --amount-sats <n> [--memo <text>] [--expires-at <iso>]",
    "  emporion settlement pay [--data-dir <path>|--context <name>] --deal-id <id> --invoice <bolt11>",
    "  emporion settlement status [--data-dir <path>|--context <name>] --deal-id <id>",
    "  emporion agent payment-endpoint add --data-dir <path> --id <id> --capability <cap>[,<cap>...]",
    "  emporion agent wallet-attestation add --data-dir <path> --attestation-id <id> --wallet-account-id <id> --balance-sats <n> --expires-at <iso>",
    "  emporion agent feedback add --data-dir <path> --credential-id <id> --issuer-did <did> --contract-id <id> --agreement-id <id> --score <n> --max-score <n>",
    "  emporion company create --data-dir <path> --name <name> [--description <text>]",
    "  emporion company update --data-dir <path> --company-did <did> [--name <name>] [--description <text>]",
    "  emporion company grant-role --data-dir <path> --company-did <did> --member-did <did> --role <owner|operator|member>",
    "  emporion company treasury-attest --data-dir <path> --company-did <did> --attestation-id <id> --wallet-account-id <id> --balance-sats <n> --expires-at <iso>",
    "  emporion market product create --data-dir <path> --marketplace <id> --title <title>",
    "  emporion market listing publish --data-dir <path> --marketplace <id> --title <title> --amount-sats <n>",
    "  emporion market request publish --data-dir <path> --marketplace <id> --title <title> --amount-sats <n>",
    "  emporion market offer submit --data-dir <path> --marketplace <id> --amount-sats <n>",
    "  emporion market bid submit --data-dir <path> --marketplace <id> --amount-sats <n>",
    "  emporion market agreement create --data-dir <path> --source-kind <offer|bid|listing|request> --source-id <id> --deliverable <text>",
    "  emporion contract create --data-dir <path> --origin-kind <kind> --origin-id <id> --party <did>[,<did>...] --scope <text> --milestones-json <json> --deliverable-schema-json <json> --proof-policy-json <json> --resolution-policy-json <json> --settlement-policy-json <json> --deadline-policy-json <json>",
    "  emporion evidence record --data-dir <path> --contract-id <id> --milestone-id <id> --proof-mode <mode>[,<mode>...] [--artifact-json <json>] [--verifier-json <json>]",
    "  emporion oracle attest --data-dir <path> --claim-type <type> --subject-kind <kind> --subject-id <id> --outcome <outcome> --expires-at <iso>",
    "  emporion dispute open --data-dir <path> --contract-id <id> --reason <text>",
    "  emporion space create --data-dir <path> --space-kind <kind> --owner-kind <kind> --owner-id <id>",
    "  emporion message send --data-dir <path> --space-id <id> --body <text>",
    "  emporion market list --data-dir <path> --marketplace <id>",
    "  emporion object show --data-dir <path> --kind <kind> --id <id>",
    "  emporion daemon start --data-dir <path> [--marketplace <id>] [--company <did>] [--agent-topic]",
    "  emporion daemon status --data-dir <path>",
    "  emporion daemon stop --data-dir <path>",
    "  emporion daemon logs --data-dir <path> [--tail <n>] [--follow]"
  ].join("\n");
}

function getDataDirFromArgs(args: ParsedArgs): string | undefined {
  return getOptionalOption(args, "data-dir");
}

async function withResolvedDataDir(args: ParsedArgs): Promise<ParsedArgs> {
  if (isContextCommand(args.commandPath)) {
    return args;
  }
  if (getOptionalOption(args, "data-dir")) {
    return args;
  }
  const requestedContext = getOptionalOption(args, "context");
  const store = new ContextStore();
  const resolved = await store.resolveDataDir(requestedContext);
  if (requestedContext && !resolved) {
    throw new Error(`Unknown context: ${requestedContext}`);
  }
  if (!resolved) {
    return args;
  }
  const options = new Map<string, string[]>(args.options);
  options.set("data-dir", [resolved]);
  return {
    commandPath: [...args.commandPath],
    options
  };
}

function withDaemonWalletKeyForwarding(args: ParsedArgs): ParsedArgs {
  if (!isWalletCommand(args.commandPath)) {
    return args;
  }
  if (getOptionalOption(args, "wallet-key")) {
    return args;
  }
  const walletKey = process.env.EMPORION_WALLET_KEY;
  if (!walletKey || walletKey.trim().length === 0) {
    return args;
  }

  const options = new Map<string, string[]>(args.options);
  options.set("wallet-key", [walletKey]);
  return {
    commandPath: [...args.commandPath],
    options
  };
}

function getDaemonProxyTimeoutMs(commandPath: string[]): number {
  if (isWalletCommand(commandPath) || commandPath[0] === "settlement") {
    return WALLET_DAEMON_PROXY_TIMEOUT_MS;
  }
  return DEFAULT_DAEMON_PROXY_TIMEOUT_MS;
}

function createCaptureIo(): { stdout: string[]; stderr: string[]; io: CliIo } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout(message) {
        stdout.push(message);
      },
      stderr(message) {
        stderr.push(message);
      }
    }
  };
}

function buildTransportConfigFromArgs(args: ParsedArgs): TransportConfig {
  const dataDir = requireOption(args, "data-dir");
  const logLevel = parseEnum(getOptionalOption(args, "log-level") ?? "info", "--log-level", [
    "debug",
    "info",
    "warn",
    "error"
  ] as const) as LogLevel;
  const bootstrap = getCsvOptionValues(args, "bootstrap");
  return {
    dataDir,
    logLevel,
    ...(bootstrap.length > 0 ? { bootstrap } : {})
  };
}

function buildTopicsFromArgs(args: ParsedArgs, agentDid: string): TopicRef[] {
  const topics: TopicRef[] = [];
  if (hasFlag(args, "agent-topic")) {
    topics.push({ kind: "agent", agentDid });
  }
  for (const marketplaceId of getCsvOptionValues(args, "marketplace")) {
    topics.push({ kind: "marketplace", marketplaceId });
  }
  for (const companyId of getCsvOptionValues(args, "company")) {
    topics.push({ kind: "company", companyId });
  }
  return topics;
}

function getDaemonStartupOptions(args: ParsedArgs): {
  topics: TopicRef[];
  connectDids: string[];
  connectNoiseKeys: string[];
  watchProtocol: boolean;
} {
  return {
    topics: [],
    connectDids: getCsvOptionValues(args, "connect-did"),
    connectNoiseKeys: getCsvOptionValues(args, "connect-noise-key"),
    watchProtocol: !hasFlag(args, "no-watch-protocol")
  };
}

function sanitizeExecArgv(): string[] {
  return process.execArgv.filter((value) => value !== "--test" && !value.startsWith("--test-"));
}

function buildDaemonRunArgv(args: ParsedArgs): string[] {
  const forwarded = new Set([
    "data-dir",
    "log-level",
    "bootstrap",
    "marketplace",
    "company",
    "connect-did",
    "connect-noise-key",
    "agent-topic",
    "no-watch-protocol"
  ]);
  const argv = [...sanitizeExecArgv()];
  argv.push(fileURLToPath(import.meta.url), "daemon", "run");
  for (const [name, values] of args.options.entries()) {
    if (!forwarded.has(name)) {
      continue;
    }
    for (const value of values) {
      argv.push(`--${name}`);
      if (value !== "true") {
        argv.push(value);
      }
    }
  }
  return argv;
}

function tailText(input: string, lineCount: number): string {
  if (lineCount <= 0) {
    return "";
  }
  const lines = input.split("\n");
  const slice = lines.slice(Math.max(lines.length - lineCount - 1, 0)).join("\n");
  return slice.length > 0 && !slice.endsWith("\n") ? `${slice}\n` : slice;
}

async function readDaemonLogTail(dataDir: string, lineCount: number): Promise<string> {
  try {
    return tailText(await readFile(getDaemonLogPath(dataDir), "utf8"), lineCount);
  } catch {
    return "";
  }
}

async function waitForDaemonReady(dataDir: string, timeoutMs: number): Promise<DaemonStatus> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const status = await probeDaemonStatus(dataDir, 1_000);
      if (status) {
        return status;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await sleep(100);
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error(`Daemon for ${dataDir} did not become ready within ${timeoutMs}ms`);
}

async function waitForDaemonExit(dataDir: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await probeDaemonStatus(dataDir, 1_000);
      if (!status) {
        return;
      }
    } catch {
      // The daemon may tear down the socket before the pid disappears.
    }
    await sleep(100);
  }
  throw new Error(`Daemon for ${dataDir} did not stop within ${timeoutMs}ms`);
}

async function proxyParsedArgsToDaemon(args: ParsedArgs, io: CliIo): Promise<number> {
  const dataDir = getDataDirFromArgs(args);
  if (!dataDir) {
    return 1;
  }

  const response = await sendDaemonCommand(
    dataDir,
    daemonRequestFromParsed(args.commandPath, daemonRequestOptionsToRecord(args.options)),
    getDaemonProxyTimeoutMs(args.commandPath)
  );
  if (!response.ok) {
    throw new Error(response.error ?? "Daemon command failed");
  }
  if (response.result !== undefined) {
    writeJson(io, response.result);
  }
  return 0;
}

async function executeCapturedInDaemon(args: ParsedArgs): Promise<unknown> {
  const capture = createCaptureIo();
  const exitCode = await executeParsedArgs(args, capture.io, { allowDaemonProxy: false });
  if (exitCode !== 0) {
    throw new Error(capture.stderr.join("").trim() || "Daemon command failed");
  }
  const output = capture.stdout.join("").trim();
  return output.length === 0 ? null : JSON.parse(output);
}

async function handleDaemonStart(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const existing = await probeDaemonStatus(dataDir, 1_000);
  if (existing) {
    writeJson(io, {
      command: "daemon.start",
      alreadyRunning: true,
      status: existing
    });
    return;
  }

  await ensureDaemonRuntimeDir(dataDir);
  const logFd = openDaemonLogFd(dataDir);
  let childError: Error | undefined;
  try {
    const child = spawn(process.execPath, buildDaemonRunArgv(args), {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        EMPORION_DAEMON: "1"
      }
    });
    child.once("error", (error) => {
      childError = error;
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }

  if (childError) {
    throw childError;
  }
  const status = await waitForDaemonReady(dataDir, 10_000);
  writeJson(io, {
    command: "daemon.start",
    alreadyRunning: false,
    status
  });
}

async function handleDaemonStatus(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const status = await probeDaemonStatus(dataDir, 1_000);
  if (!status) {
    throw new Error(`No daemon is running for ${dataDir}`);
  }
  writeJson(io, {
    command: "daemon.status",
    status
  });
}

async function handleDaemonStop(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const status = await probeDaemonStatus(dataDir, 1_000);
  if (!status) {
    await cleanupStaleDaemonArtifacts(dataDir);
    writeJson(io, {
      command: "daemon.stop",
      stopped: true,
      alreadyStopped: true
    });
    return;
  }

  const response = await sendDaemonCommand(dataDir, {
    commandPath: ["daemon", "stop"],
    options: {}
  });
  if (!response.ok) {
    throw new Error(response.error ?? "Daemon stop request failed");
  }
  await waitForDaemonExit(dataDir, 10_000);
  writeJson(io, {
    command: "daemon.stop",
    stopped: true,
    pid: status.pid
  });
}

async function handleDaemonLogs(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const tail = parseNonNegativeInteger(getOptionalOption(args, "tail") ?? "100", "--tail");
  const follow = hasFlag(args, "follow");

  const logPath = getDaemonLogPath(dataDir);
  let currentContents = await readDaemonLogTail(dataDir, tail);
  if (currentContents.length > 0) {
    io.stdout(currentContents);
  }
  if (!follow) {
    return;
  }

  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    try {
      currentContents = await readFile(logPath, "utf8");
    } catch {
      currentContents = "";
    }
    let lastLength = currentContents.length;
    while (!stopped) {
      await sleep(500);
      if (stopped) {
        break;
      }
      try {
        const next = await readFile(logPath, "utf8");
        if (next.length > lastLength) {
          io.stdout(next.slice(lastLength));
        }
        lastLength = next.length;
      } catch {
        // Keep polling while the operator waits for logs to appear.
      }
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function buildDaemonSharedContext(dataDir: string, transport: AgentTransport, walletService: WalletService): Promise<CliContext> {
  const identityMaterial = transport.getIdentityMaterial();
  const repository = await Protocol.ProtocolRepository.create(dataDir);
  return {
    dataDir,
    identityMaterial,
    repository,
    transportStorage: transport.getStorage(),
    walletService,
    signer: {
      did: identityMaterial.agentIdentity.did,
      publicKey: identityMaterial.transportKeyPair.publicKey,
      secretKey: identityMaterial.transportKeyPair.secretKey
    }
  };
}

function buildDaemonStatus(
  dataDir: string,
  startedAt: string,
  transport: AgentTransport,
  walletStatus: DaemonStatus["wallet"]
): DaemonStatus {
  return {
    dataDir: normalizeDataDirPath(dataDir),
    pid: process.pid,
    startedAt,
    identity: transport.identity,
    runtimeEndpoint: getLocalControlEndpoint(dataDir).path,
    logPath: getDaemonLogPath(dataDir),
    topics: transport.getJoinedTopics(),
    connectedPeers: [...transport.getPeerSessions().values()],
    wallet: walletStatus,
    healthy: true
  };
}

function collectAutoSettleCandidates(snapshot: {
  offers: ReadonlyMap<string, Protocol.OfferState>;
  bids: ReadonlyMap<string, Protocol.BidState>;
  agreements: ReadonlyMap<string, Protocol.AgreementState>;
}): AutoSettleCandidate[] {
  const candidates: AutoSettleCandidate[] = [];

  for (const offer of snapshot.offers.values()) {
    if (offer.status !== "accepted") {
      continue;
    }
    for (const lightningRef of offer.lightningRefs) {
      candidates.push({
        triggerObjectKind: "offer",
        triggerObjectId: offer.objectId,
        eventId: offer.latestEventId,
        lightningRef,
        amountSats: offer.paymentTerms.amountSats
      });
    }
  }

  for (const bid of snapshot.bids.values()) {
    if (bid.status !== "accepted") {
      continue;
    }
    for (const lightningRef of bid.lightningRefs) {
      candidates.push({
        triggerObjectKind: "bid",
        triggerObjectId: bid.objectId,
        eventId: bid.latestEventId,
        lightningRef,
        amountSats: bid.paymentTerms.amountSats
      });
    }
  }

  for (const agreement of snapshot.agreements.values()) {
    if (agreement.status !== "active") {
      continue;
    }
    for (const lightningRef of agreement.lightningRefs) {
      candidates.push({
        triggerObjectKind: "agreement",
        triggerObjectId: agreement.objectId,
        eventId: agreement.latestEventId,
        lightningRef,
        amountSats: agreement.paymentTerms.amountSats
      });
    }
  }

  return candidates;
}

async function runProtocolDiscoveryWatcher(
  transport: AgentTransport,
  seenControlLengths: Map<string, number>,
  io: CliIo
): Promise<void> {
  for (const session of transport.getPeerSessions().values()) {
    const remoteFeed = transport.getRemoteFeed(session.remoteControlFeedKey);
    if (!remoteFeed) {
      continue;
    }
    await remoteFeed.update({ wait: false });
    const seenLength = seenControlLengths.get(session.remoteControlFeedKey) ?? 0;
    if (remoteFeed.length <= seenLength) {
      continue;
    }
    for (let index = seenLength; index < remoteFeed.length; index += 1) {
      const entry = await remoteFeed.get(index);
      if (Protocol.isProtocolAnnouncement(entry)) {
        io.stdout(`${JSON.stringify({ command: "daemon.discovery", remoteDid: session.remoteDid, announcement: entry })}\n`);
      }
    }
    seenControlLengths.set(session.remoteControlFeedKey, remoteFeed.length);
  }
}

async function waitForProcessSignal(): Promise<void> {
  await Promise.race([
    once(process, "SIGINT").then(() => undefined),
    once(process, "SIGTERM").then(() => undefined)
  ]);
}

async function handleDaemonRun(args: ParsedArgs, io: CliIo): Promise<void> {
  const dataDir = requireOption(args, "data-dir");
  const startup = getDaemonStartupOptions(args);
  const walletService = await WalletService.create({
    dataDir,
    logger: createLogger("warn")
  });
  walletService.setRuntimeKey(process.env.EMPORION_WALLET_KEY ?? null);
  let transport: AgentTransport | undefined;
  let sharedContext: CliContext | undefined;
  let daemon: AgentDaemon | undefined;
  let discoveryInterval: NodeJS.Timeout | undefined;
  let walletPollInterval: NodeJS.Timeout | undefined;
  let autoSettleInterval: NodeJS.Timeout | undefined;
  let walletStatus: DaemonStatus["wallet"] = await walletService.daemonStatus();
  let walletPollRunning = false;
  let autoSettleRunning = false;
  const seenControlLengths = new Map<string, number>();
  const startedAt = new Date().toISOString();

  try {
    transport = await AgentTransport.create(buildTransportConfigFromArgs(args));
    await transport.start();
    const activeTransport = transport;
    sharedContext = await buildDaemonSharedContext(dataDir, activeTransport, walletService);

    const topics = buildTopicsFromArgs(args, activeTransport.identity.did);
    startup.topics.push(...topics);
    for (const topic of startup.topics) {
      await activeTransport.joinTopic(topic);
    }
    for (const did of startup.connectDids) {
      await activeTransport.connectToDid(did);
    }
    for (const publicKey of startup.connectNoiseKeys) {
      await activeTransport.connectToNoiseKey(publicKey);
    }

    if (startup.watchProtocol) {
      discoveryInterval = setInterval(() => {
        void runProtocolDiscoveryWatcher(activeTransport, seenControlLengths, io).catch((error: unknown) => {
          io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
        });
      }, 2_000);
    }

    walletPollInterval = setInterval(() => {
      if (walletPollRunning) {
        return;
      }
      walletPollRunning = true;
      void (async () => {
        try {
          await walletService.pollUpdates();
          walletStatus = await walletService.daemonStatus();
        } catch (error) {
          io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
        } finally {
          walletPollRunning = false;
        }
      })();
    }, 3_000);

    autoSettleInterval = setInterval(() => {
      if (autoSettleRunning || !sharedContext) {
        return;
      }
      autoSettleRunning = true;
      void (async () => {
        try {
          const candidates = collectAutoSettleCandidates(sharedContext.repository.getSnapshot());
          for (const candidate of candidates) {
            await walletService.attemptAutoSettle(candidate);
          }
          walletStatus = await walletService.daemonStatus();
        } catch (error) {
          io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
        } finally {
          autoSettleRunning = false;
        }
      })();
    }, 2_000);

    daemon = new AgentDaemon({
      dataDir,
      statusProvider: () => buildDaemonStatus(dataDir, startedAt, activeTransport, walletStatus),
      commandHandler: async (request: DaemonCommandRequest) => {
        if (!sharedContext) {
          throw new Error("Daemon context is not available");
        }
        const result = await CLI_CONTEXT_STORAGE.run(sharedContext, async () =>
          executeCapturedInDaemon({
            commandPath: request.commandPath,
            options: daemonOptionsRecordToMap(request.options)
          })
        );
        walletStatus = await walletService.daemonStatus();
        return result;
      },
      onShutdown: async () => {
        if (discoveryInterval) {
          clearInterval(discoveryInterval);
          discoveryInterval = undefined;
        }
        if (walletPollInterval) {
          clearInterval(walletPollInterval);
          walletPollInterval = undefined;
        }
        if (autoSettleInterval) {
          clearInterval(autoSettleInterval);
          autoSettleInterval = undefined;
        }
        if (sharedContext) {
          await sharedContext.repository.close();
          sharedContext = undefined;
        }
        await walletService.close();
        await activeTransport.stop();
      }
    });

    await daemon.start();
    io.stdout(`${JSON.stringify({ command: "daemon.run", pid: process.pid, endpoint: getLocalControlEndpoint(dataDir).path })}\n`);
    await Promise.race([daemon.waitForShutdown(), waitForProcessSignal()]);
  } finally {
    if (daemon) {
      await daemon.stop();
    } else {
      if (discoveryInterval) {
        clearInterval(discoveryInterval);
      }
      if (walletPollInterval) {
        clearInterval(walletPollInterval);
      }
      if (autoSettleInterval) {
        clearInterval(autoSettleInterval);
      }
      if (sharedContext) {
        await sharedContext.repository.close();
      }
      await walletService.close();
      if (transport) {
        await transport.stop();
      }
    }
  }
}

async function executeParsedArgs(args: ParsedArgs, io: CliIo, options: DispatchOptions): Promise<number> {
  if (args.commandPath.length === 0 || hasFlag(args, "help")) {
    io.stdout(`${usage()}\n`);
    return 0;
  }

  const resolvedArgs = await withResolvedDataDir(args);

  if (commandMatches(resolvedArgs.commandPath, "daemon", "start")) return await handleDaemonStart(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "daemon", "status")) return await handleDaemonStatus(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "daemon", "stop")) return await handleDaemonStop(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "daemon", "logs")) return await handleDaemonLogs(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "daemon", "run")) return await handleDaemonRun(resolvedArgs, io).then(() => 0);

  if (options.allowDaemonProxy) {
    const dataDir = getDataDirFromArgs(resolvedArgs);
    if (dataDir) {
      const activeDaemon = await probeDaemonStatus(dataDir, 1_000);
      if (activeDaemon) {
        return proxyParsedArgsToDaemon(withDaemonWalletKeyForwarding(resolvedArgs), io);
      }
    }
  }

  if (commandMatches(resolvedArgs.commandPath, "context", "add")) return await handleContextAdd(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "context", "use")) return await handleContextUse(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "context", "list")) return await handleContextList(io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "context", "show")) return await handleContextShow(io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "context", "remove")) return await handleContextRemove(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "agent", "init")) return await handleAgentInit(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "wallet", "connect", "nwc")) return await handleWalletConnectNwc(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "wallet", "connect", "circle")) return await handleWalletConnectCircle(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "wallet", "disconnect")) return await handleWalletDisconnect(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "wallet", "status")) return await handleWalletStatus(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "wallet", "unlock")) return await handleWalletUnlock(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "wallet", "lock")) return await handleWalletLock(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "wallet", "invoice", "create")) return await handleWalletInvoiceCreate(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "wallet", "pay", "bolt11")) return await handleWalletPayBolt11(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "wallet", "pay", "x402")) return await handleWalletPayX402(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "wallet", "ledger", "list")) return await handleWalletLedgerList(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "wallet", "key", "rotate")) return await handleWalletKeyRotate(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "deal", "open")) return await handleDealOpen(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "deal", "propose")) return await handleDealPropose(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "deal", "accept")) return await handleDealAccept(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "deal", "start")) return await handleDealStart(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "deal", "status")) return await handleDealStatus(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "proof", "submit")) return await handleProofSubmit(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "proof", "accept")) return await handleProofAccept(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "settlement", "invoice", "create")) return await handleSettlementInvoiceCreate(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "settlement", "pay")) return await handleSettlementPay(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "settlement", "status")) return await handleSettlementStatus(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "agent", "show")) return await handleAgentShow(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "agent", "payment-endpoint", "add")) return await handleAgentPaymentEndpointAdd(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "agent", "payment-endpoint", "remove")) return await handleAgentPaymentEndpointRemove(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "agent", "wallet-attestation", "add")) return await handleAgentWalletAttestationAdd(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "agent", "wallet-attestation", "remove")) return await handleAgentWalletAttestationRemove(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "agent", "feedback", "add")) return await handleAgentFeedbackAdd(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "agent", "feedback", "remove")) return await handleAgentFeedbackRemove(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "company", "create")) return await handleCompanyCreate(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "company", "show")) return await handleCompanyShow(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "company", "update")) return await handleCompanyUpdate(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "company", "grant-role")) return await handleCompanyRoleChange(resolvedArgs, io, "grant").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "company", "revoke-role")) return await handleCompanyRoleChange(resolvedArgs, io, "revoke").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "company", "join-market")) return await handleCompanyMarketMembership(resolvedArgs, io, "join").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "company", "leave-market")) return await handleCompanyMarketMembership(resolvedArgs, io, "leave").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "company", "treasury-attest")) return await handleCompanyTreasuryAttest(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "company", "treasury-reserve")) return await handleCompanyTreasuryReserve(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "company", "treasury-release")) return await handleCompanyTreasuryRelease(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "product", "create")) return await handleMarketProductCreate(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "product", "update")) return await handleMarketProductUpdate(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "product", "publish")) return await handleMarketProductStateChange(resolvedArgs, io, "product.published").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "product", "unpublish")) return await handleMarketProductStateChange(resolvedArgs, io, "product.unpublished").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "product", "retire")) return await handleMarketProductStateChange(resolvedArgs, io, "product.retired").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "listing", "publish")) return await handleMarketListingPublish(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "listing", "revise")) return await handleMarketListingRevise(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "listing", "withdraw")) return await handleSimpleMarketStateChange(resolvedArgs, io, "listing", "listing.withdrawn").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "listing", "expire")) return await handleSimpleMarketStateChange(resolvedArgs, io, "listing", "listing.expired").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "request", "publish")) return await handleMarketRequestPublish(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "request", "revise")) return await handleMarketRequestRevise(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "request", "close")) return await handleSimpleMarketStateChange(resolvedArgs, io, "request", "request.closed").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "request", "expire")) return await handleSimpleMarketStateChange(resolvedArgs, io, "request", "request.expired").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "offer", "submit")) return await handleMarketOfferSubmit(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "offer", "counter")) return await handleMarketOfferCounter(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "offer", "accept")) return await handleSimpleMarketStateChange(resolvedArgs, io, "offer", "offer.accepted").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "offer", "reject")) return await handleSimpleMarketStateChange(resolvedArgs, io, "offer", "offer.rejected").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "offer", "cancel")) return await handleSimpleMarketStateChange(resolvedArgs, io, "offer", "offer.canceled").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "offer", "expire")) return await handleSimpleMarketStateChange(resolvedArgs, io, "offer", "offer.expired").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "bid", "submit")) return await handleMarketBidSubmit(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "bid", "counter")) return await handleMarketBidCounter(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "bid", "accept")) return await handleSimpleMarketStateChange(resolvedArgs, io, "bid", "bid.accepted").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "bid", "reject")) return await handleSimpleMarketStateChange(resolvedArgs, io, "bid", "bid.rejected").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "bid", "cancel")) return await handleSimpleMarketStateChange(resolvedArgs, io, "bid", "bid.canceled").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "bid", "expire")) return await handleSimpleMarketStateChange(resolvedArgs, io, "bid", "bid.expired").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "agreement", "create")) return await handleMarketAgreementCreate(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "agreement", "complete")) return await handleSimpleMarketStateChange(resolvedArgs, io, "agreement", "agreement.completed").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "agreement", "cancel")) return await handleSimpleMarketStateChange(resolvedArgs, io, "agreement", "agreement.canceled").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "agreement", "dispute")) return await handleSimpleMarketStateChange(resolvedArgs, io, "agreement", "agreement.disputed").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "market", "list")) return await handleMarketList(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "contract", "create")) return await handleContractCreate(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "contract", "open-milestone")) return await handleContractMilestoneAction(resolvedArgs, io, "contract.milestone-opened").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "contract", "submit-milestone")) return await handleContractMilestoneAction(resolvedArgs, io, "contract.milestone-submitted").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "contract", "accept-milestone")) return await handleContractMilestoneAction(resolvedArgs, io, "contract.milestone-accepted").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "contract", "reject-milestone")) return await handleContractMilestoneAction(resolvedArgs, io, "contract.milestone-rejected").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "contract", "pause")) return await handleContractStateChange(resolvedArgs, io, "contract.paused").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "contract", "resume")) return await handleContractStateChange(resolvedArgs, io, "contract.resumed").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "contract", "complete")) return await handleContractStateChange(resolvedArgs, io, "contract.completed").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "contract", "cancel")) return await handleContractStateChange(resolvedArgs, io, "contract.canceled").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "contract", "dispute")) return await handleContractStateChange(resolvedArgs, io, "contract.disputed").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "contract", "entries")) return await handleContractEntries(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "evidence", "record")) return await handleEvidenceRecord(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "oracle", "attest")) return await handleOracleAttest(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "dispute", "open")) return await handleDisputeOpen(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "dispute", "add-evidence")) return await handleDisputeAddEvidence(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "dispute", "request-oracle")) return await handleDisputeRequestOracle(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "dispute", "rule")) return await handleDisputeRule(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "dispute", "close")) return await handleDisputeClose(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "space", "create")) return await handleSpaceCreate(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "space", "add-member")) return await handleSpaceMembershipAction(resolvedArgs, io, "space-membership.member-added").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "space", "remove-member")) return await handleSpaceMembershipAction(resolvedArgs, io, "space-membership.member-removed").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "space", "mute-member")) return await handleSpaceMembershipAction(resolvedArgs, io, "space-membership.member-muted").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "space", "set-role")) return await handleSpaceMembershipAction(resolvedArgs, io, "space-membership.member-role-updated").then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "space", "entries")) return await handleSpaceEntries(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "message", "send")) return await handleMessageSend(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "message", "edit")) return await handleMessageEdit(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "message", "delete")) return await handleMessageDelete(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "message", "react")) return await handleMessageReact(resolvedArgs, io).then(() => 0);
  if (commandMatches(resolvedArgs.commandPath, "object", "show")) return await handleObjectShow(resolvedArgs, io).then(() => 0);
  throw new Error(`Unknown command: ${resolvedArgs.commandPath.join(" ")}`);
}

export async function runCli(argv: string[], io: CliIo = DEFAULT_IO): Promise<number> {
  try {
    const args = parseArgs(argv);
    return await executeParsedArgs(args, io, { allowDaemonProxy: true });
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const executedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === executedPath) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
