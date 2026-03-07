#!/usr/bin/env node

import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
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
  signer: Protocol.ProtocolSigner;
}

type StateWithLatestEventId = { latestEventId: string; eventIds: string[] };
type CliContextRunner = <T>(dataDir: string, fn: (context: CliContext) => Promise<T>) => Promise<T>;

interface DispatchOptions {
  allowDaemonProxy: boolean;
}

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

async function openCliContext(dataDir: string): Promise<CliContext> {
  const identityMaterial = await loadPersistentIdentityMaterial(dataDir);
  const repository = await Protocol.ProtocolRepository.create(dataDir);
  const transportStorage = await TransportStorage.create(dataDir, identityMaterial.storagePrimaryKey, createLogger("error"));
  await transportStorage.initializeDefaults();

  return {
    dataDir,
    identityMaterial,
    repository,
    transportStorage,
    signer: {
      did: identityMaterial.agentIdentity.did,
      publicKey: identityMaterial.transportKeyPair.publicKey,
      secretKey: identityMaterial.transportKeyPair.secretKey
    }
  };
}

async function closeCliContext(context: CliContext): Promise<void> {
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
    return await fn(context);
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

function usage(): string {
  return [
    "Usage:",
    "  emporion agent init --data-dir <path> [--display-name <name>] [--bio <text>]",
    "  emporion agent show --data-dir <path>",
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
    daemonRequestFromParsed(args.commandPath, daemonRequestOptionsToRecord(args.options))
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

async function buildDaemonSharedContext(dataDir: string, transport: AgentTransport): Promise<CliContext> {
  const identityMaterial = transport.getIdentityMaterial();
  const repository = await Protocol.ProtocolRepository.create(dataDir);
  return {
    dataDir,
    identityMaterial,
    repository,
    transportStorage: transport.getStorage(),
    signer: {
      did: identityMaterial.agentIdentity.did,
      publicKey: identityMaterial.transportKeyPair.publicKey,
      secretKey: identityMaterial.transportKeyPair.secretKey
    }
  };
}

function buildDaemonStatus(dataDir: string, startedAt: string, transport: AgentTransport): DaemonStatus {
  return {
    dataDir: normalizeDataDirPath(dataDir),
    pid: process.pid,
    startedAt,
    identity: transport.identity,
    runtimeEndpoint: getLocalControlEndpoint(dataDir).path,
    logPath: getDaemonLogPath(dataDir),
    topics: transport.getJoinedTopics(),
    connectedPeers: [...transport.getPeerSessions().values()],
    healthy: true
  };
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
  const transport = await AgentTransport.create(buildTransportConfigFromArgs(args));
  const startup = getDaemonStartupOptions(args);
  let sharedContext: CliContext | undefined;
  let daemon: AgentDaemon | undefined;
  let discoveryInterval: NodeJS.Timeout | undefined;
  const seenControlLengths = new Map<string, number>();
  const startedAt = new Date().toISOString();

  try {
    await transport.start();
    sharedContext = await buildDaemonSharedContext(dataDir, transport);

    const topics = buildTopicsFromArgs(args, transport.identity.did);
    startup.topics.push(...topics);
    for (const topic of startup.topics) {
      await transport.joinTopic(topic);
    }
    for (const did of startup.connectDids) {
      await transport.connectToDid(did);
    }
    for (const publicKey of startup.connectNoiseKeys) {
      await transport.connectToNoiseKey(publicKey);
    }

    if (startup.watchProtocol) {
      discoveryInterval = setInterval(() => {
        void runProtocolDiscoveryWatcher(transport, seenControlLengths, io).catch((error: unknown) => {
          io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
        });
      }, 2_000);
    }

    daemon = new AgentDaemon({
      dataDir,
      statusProvider: () => buildDaemonStatus(dataDir, startedAt, transport),
      commandHandler: async (request: DaemonCommandRequest) => {
        if (!sharedContext) {
          throw new Error("Daemon context is not available");
        }
        return CLI_CONTEXT_STORAGE.run(sharedContext, async () =>
          executeCapturedInDaemon({
            commandPath: request.commandPath,
            options: daemonOptionsRecordToMap(request.options)
          })
        );
      },
      onShutdown: async () => {
        if (discoveryInterval) {
          clearInterval(discoveryInterval);
          discoveryInterval = undefined;
        }
        if (sharedContext) {
          await sharedContext.repository.close();
          sharedContext = undefined;
        }
        await transport.stop();
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
      if (sharedContext) {
        await sharedContext.repository.close();
      }
      await transport.stop();
    }
  }
}

async function executeParsedArgs(args: ParsedArgs, io: CliIo, options: DispatchOptions): Promise<number> {
  if (args.commandPath.length === 0 || hasFlag(args, "help")) {
    io.stdout(`${usage()}\n`);
    return 0;
  }

  if (commandMatches(args.commandPath, "daemon", "start")) return await handleDaemonStart(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "daemon", "status")) return await handleDaemonStatus(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "daemon", "stop")) return await handleDaemonStop(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "daemon", "logs")) return await handleDaemonLogs(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "daemon", "run")) return await handleDaemonRun(args, io).then(() => 0);

  if (options.allowDaemonProxy) {
    const dataDir = getDataDirFromArgs(args);
    if (dataDir) {
      const activeDaemon = await probeDaemonStatus(dataDir, 1_000);
      if (activeDaemon) {
        return proxyParsedArgsToDaemon(args, io);
      }
    }
  }

  if (commandMatches(args.commandPath, "agent", "init")) return await handleAgentInit(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "agent", "show")) return await handleAgentShow(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "agent", "payment-endpoint", "add")) return await handleAgentPaymentEndpointAdd(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "agent", "payment-endpoint", "remove")) return await handleAgentPaymentEndpointRemove(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "agent", "wallet-attestation", "add")) return await handleAgentWalletAttestationAdd(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "agent", "wallet-attestation", "remove")) return await handleAgentWalletAttestationRemove(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "agent", "feedback", "add")) return await handleAgentFeedbackAdd(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "agent", "feedback", "remove")) return await handleAgentFeedbackRemove(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "company", "create")) return await handleCompanyCreate(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "company", "show")) return await handleCompanyShow(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "company", "update")) return await handleCompanyUpdate(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "company", "grant-role")) return await handleCompanyRoleChange(args, io, "grant").then(() => 0);
  if (commandMatches(args.commandPath, "company", "revoke-role")) return await handleCompanyRoleChange(args, io, "revoke").then(() => 0);
  if (commandMatches(args.commandPath, "company", "join-market")) return await handleCompanyMarketMembership(args, io, "join").then(() => 0);
  if (commandMatches(args.commandPath, "company", "leave-market")) return await handleCompanyMarketMembership(args, io, "leave").then(() => 0);
  if (commandMatches(args.commandPath, "company", "treasury-attest")) return await handleCompanyTreasuryAttest(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "company", "treasury-reserve")) return await handleCompanyTreasuryReserve(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "company", "treasury-release")) return await handleCompanyTreasuryRelease(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "market", "product", "create")) return await handleMarketProductCreate(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "market", "product", "update")) return await handleMarketProductUpdate(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "market", "product", "publish")) return await handleMarketProductStateChange(args, io, "product.published").then(() => 0);
  if (commandMatches(args.commandPath, "market", "product", "unpublish")) return await handleMarketProductStateChange(args, io, "product.unpublished").then(() => 0);
  if (commandMatches(args.commandPath, "market", "product", "retire")) return await handleMarketProductStateChange(args, io, "product.retired").then(() => 0);
  if (commandMatches(args.commandPath, "market", "listing", "publish")) return await handleMarketListingPublish(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "market", "listing", "revise")) return await handleMarketListingRevise(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "market", "listing", "withdraw")) return await handleSimpleMarketStateChange(args, io, "listing", "listing.withdrawn").then(() => 0);
  if (commandMatches(args.commandPath, "market", "listing", "expire")) return await handleSimpleMarketStateChange(args, io, "listing", "listing.expired").then(() => 0);
  if (commandMatches(args.commandPath, "market", "request", "publish")) return await handleMarketRequestPublish(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "market", "request", "revise")) return await handleMarketRequestRevise(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "market", "request", "close")) return await handleSimpleMarketStateChange(args, io, "request", "request.closed").then(() => 0);
  if (commandMatches(args.commandPath, "market", "request", "expire")) return await handleSimpleMarketStateChange(args, io, "request", "request.expired").then(() => 0);
  if (commandMatches(args.commandPath, "market", "offer", "submit")) return await handleMarketOfferSubmit(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "market", "offer", "counter")) return await handleMarketOfferCounter(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "market", "offer", "accept")) return await handleSimpleMarketStateChange(args, io, "offer", "offer.accepted").then(() => 0);
  if (commandMatches(args.commandPath, "market", "offer", "reject")) return await handleSimpleMarketStateChange(args, io, "offer", "offer.rejected").then(() => 0);
  if (commandMatches(args.commandPath, "market", "offer", "cancel")) return await handleSimpleMarketStateChange(args, io, "offer", "offer.canceled").then(() => 0);
  if (commandMatches(args.commandPath, "market", "offer", "expire")) return await handleSimpleMarketStateChange(args, io, "offer", "offer.expired").then(() => 0);
  if (commandMatches(args.commandPath, "market", "bid", "submit")) return await handleMarketBidSubmit(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "market", "bid", "counter")) return await handleMarketBidCounter(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "market", "bid", "accept")) return await handleSimpleMarketStateChange(args, io, "bid", "bid.accepted").then(() => 0);
  if (commandMatches(args.commandPath, "market", "bid", "reject")) return await handleSimpleMarketStateChange(args, io, "bid", "bid.rejected").then(() => 0);
  if (commandMatches(args.commandPath, "market", "bid", "cancel")) return await handleSimpleMarketStateChange(args, io, "bid", "bid.canceled").then(() => 0);
  if (commandMatches(args.commandPath, "market", "bid", "expire")) return await handleSimpleMarketStateChange(args, io, "bid", "bid.expired").then(() => 0);
  if (commandMatches(args.commandPath, "market", "agreement", "create")) return await handleMarketAgreementCreate(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "market", "agreement", "complete")) return await handleSimpleMarketStateChange(args, io, "agreement", "agreement.completed").then(() => 0);
  if (commandMatches(args.commandPath, "market", "agreement", "cancel")) return await handleSimpleMarketStateChange(args, io, "agreement", "agreement.canceled").then(() => 0);
  if (commandMatches(args.commandPath, "market", "agreement", "dispute")) return await handleSimpleMarketStateChange(args, io, "agreement", "agreement.disputed").then(() => 0);
  if (commandMatches(args.commandPath, "market", "list")) return await handleMarketList(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "contract", "create")) return await handleContractCreate(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "contract", "open-milestone")) return await handleContractMilestoneAction(args, io, "contract.milestone-opened").then(() => 0);
  if (commandMatches(args.commandPath, "contract", "submit-milestone")) return await handleContractMilestoneAction(args, io, "contract.milestone-submitted").then(() => 0);
  if (commandMatches(args.commandPath, "contract", "accept-milestone")) return await handleContractMilestoneAction(args, io, "contract.milestone-accepted").then(() => 0);
  if (commandMatches(args.commandPath, "contract", "reject-milestone")) return await handleContractMilestoneAction(args, io, "contract.milestone-rejected").then(() => 0);
  if (commandMatches(args.commandPath, "contract", "pause")) return await handleContractStateChange(args, io, "contract.paused").then(() => 0);
  if (commandMatches(args.commandPath, "contract", "resume")) return await handleContractStateChange(args, io, "contract.resumed").then(() => 0);
  if (commandMatches(args.commandPath, "contract", "complete")) return await handleContractStateChange(args, io, "contract.completed").then(() => 0);
  if (commandMatches(args.commandPath, "contract", "cancel")) return await handleContractStateChange(args, io, "contract.canceled").then(() => 0);
  if (commandMatches(args.commandPath, "contract", "dispute")) return await handleContractStateChange(args, io, "contract.disputed").then(() => 0);
  if (commandMatches(args.commandPath, "contract", "entries")) return await handleContractEntries(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "evidence", "record")) return await handleEvidenceRecord(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "oracle", "attest")) return await handleOracleAttest(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "dispute", "open")) return await handleDisputeOpen(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "dispute", "add-evidence")) return await handleDisputeAddEvidence(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "dispute", "request-oracle")) return await handleDisputeRequestOracle(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "dispute", "rule")) return await handleDisputeRule(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "dispute", "close")) return await handleDisputeClose(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "space", "create")) return await handleSpaceCreate(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "space", "add-member")) return await handleSpaceMembershipAction(args, io, "space-membership.member-added").then(() => 0);
  if (commandMatches(args.commandPath, "space", "remove-member")) return await handleSpaceMembershipAction(args, io, "space-membership.member-removed").then(() => 0);
  if (commandMatches(args.commandPath, "space", "mute-member")) return await handleSpaceMembershipAction(args, io, "space-membership.member-muted").then(() => 0);
  if (commandMatches(args.commandPath, "space", "set-role")) return await handleSpaceMembershipAction(args, io, "space-membership.member-role-updated").then(() => 0);
  if (commandMatches(args.commandPath, "space", "entries")) return await handleSpaceEntries(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "message", "send")) return await handleMessageSend(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "message", "edit")) return await handleMessageEdit(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "message", "delete")) return await handleMessageDelete(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "message", "react")) return await handleMessageReact(args, io).then(() => 0);
  if (commandMatches(args.commandPath, "object", "show")) return await handleObjectShow(args, io).then(() => 0);
  throw new Error(`Unknown command: ${args.commandPath.join(" ")}`);
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
