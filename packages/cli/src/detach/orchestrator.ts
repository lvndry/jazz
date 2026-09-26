/**
 * Operator initiated conversation handoff to a registered SSH host.
 *
 * Preparation is read-only with respect to conversation ownership. Commit fences the local
 * conversation before sending a verified snapshot. A failure after remote start is ambiguous:
 * the local fence stays in place and status must reconcile by the same handoff id.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { parseDetachEvent, type TimedDetachEvent } from "@jazz/adapters/detach/events";
import {
  ensureRemoteJazz,
  downloadRemoteHelper,
  followRemoteEvents,
  probeRemoteHost,
  probeRemoteProvider,
  runRemoteHelper,
  runRemoteHelperStream,
  transferRemoteSecret,
} from "@jazz/adapters/detach/remote-host";
import {
  applyDetachResult,
  compareDetachWorkspaces,
  createDetachSnapshot,
  verifyDetachSnapshot,
  type DetachManifest,
} from "@jazz/adapters/detach/snapshot";
import { encodeDetachBundle, receiveDetachBundle } from "@jazz/adapters/detach/transfer-protocol";
import { detectKeyringBackend, keyringGet } from "@jazz/adapters/secrets/keyring";
import { llmProviderApiKeyFromEnv } from "@jazz/adapters/secrets/registry";
import {
  abortDetach,
  commitDetach,
  prepareDetach,
  releaseDetach,
} from "@jazz/core/agent/detach/ownership";
import { isProviderName, type ProviderName } from "@jazz/core/constants/models";
import type { HostProfile } from "@jazz/core/types/host";
import type { ChatMessage } from "@jazz/core/types/message";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { Effect } from "effect";
import packageJson from "../../../../package.json";

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const DEFAULT_MAX_COST_USD = 5;
const DEFAULT_MAX_DURATION_MS = 8 * 60 * 60 * 1000;
const DEFAULT_MAX_ITERATIONS = 100;

export interface DetachPreview {
  readonly handoffId: string;
  readonly hostName: string;
  readonly manifest: DetachManifest;
  readonly bytes: number;
  readonly continuation: string;
  readonly credentialNames: readonly string[];
  readonly warnings: readonly string[];
  readonly approvalPolicy: "low-risk";
  readonly maxCostUSD: number;
  readonly maxDurationMs: number;
  readonly maxIterations: number;
  /** Internal paths remain local; the confirmation card must not print them. */
  readonly bundleDirectory: string;
  readonly host: HostProfile;
}

export interface DetachReceipt {
  readonly handoffId: string;
  readonly hostName: string;
  readonly state: "accepted" | "running" | "parked" | "completed";
}

export interface DetachStatus {
  readonly handoffId: string;
  readonly hostName: string;
  readonly state:
    | "preparing"
    | "running"
    | "parked"
    | "completed"
    | "failed"
    | "released"
    | "reclaimed"
    | "unknown";
  readonly detail?: string;
  readonly approvalAvailable?: boolean;
}

export interface DetachPullPreview {
  readonly handoffId: string;
  readonly hostName: string;
  readonly resultDirectory: string;
  readonly changedPaths: readonly string[];
  readonly conflicts: readonly string[];
}

/** A failed commit states whether it is safe to keep using the local conversation. */
export class DetachCommitError extends Error {
  constructor(
    message: string,
    readonly localMayContinue: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DetachCommitError";
  }
}

const LOCAL_TRANSFER_STATES = ["prepared", "preparing", "remote", "reclaimed"] as const;

export interface LocalTransferRecord {
  readonly handoffId: string;
  readonly host: HostProfile;
  readonly agentId: string;
  readonly conversationId: string;
  readonly state: (typeof LOCAL_TRANSFER_STATES)[number];
}

export interface DetachReclaimResult {
  readonly handoffId: string;
  readonly hostName: string;
  readonly agentId: string;
  readonly conversationId: string;
  readonly applied: boolean;
  readonly changedPaths: readonly string[];
  readonly conflicts: readonly string[];
}

function transfersDirectory(): string {
  return path.join(getJazzHomeDirectory(), "detach", "transfers");
}

function transferPath(id: string): string {
  if (!ID.test(id)) {
    throw new Error("Invalid handoff id");
  }
  return path.join(transfersDirectory(), `${id}.json`);
}

function stagingPath(id: string): string {
  return path.join(getJazzHomeDirectory(), "detach", "staging", id);
}

async function saveLocalTransfer(record: LocalTransferRecord): Promise<void> {
  const file = transferPath(record.handoffId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
  await fs.rename(tmp, file);
}

async function loadLocalTransfer(handoffId: string): Promise<LocalTransferRecord> {
  const parsed: unknown = JSON.parse(await fs.readFile(transferPath(handoffId), "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid local handoff record");
  }
  const value = parsed as Record<string, unknown>;
  const host = value["host"];
  if (
    value["handoffId"] !== handoffId ||
    typeof value["agentId"] !== "string" ||
    typeof value["conversationId"] !== "string" ||
    !(LOCAL_TRANSFER_STATES as readonly string[]).includes(String(value["state"])) ||
    typeof host !== "object" ||
    host === null ||
    typeof (host as Record<string, unknown>)["name"] !== "string" ||
    typeof (host as Record<string, unknown>)["sshTarget"] !== "string" ||
    typeof (host as Record<string, unknown>)["workspacePath"] !== "string"
  ) {
    throw new Error("Invalid local handoff record");
  }
  return parsed as LocalTransferRecord;
}

async function registeredHost(name: string): Promise<HostProfile> {
  const raw = await fs.readFile(path.join(getJazzHomeDirectory(), "config.json"), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { hosts?: unknown }).hosts)
  ) {
    throw new Error("No remote hosts registered. Run `jazz hosts add` first.");
  }
  const host = (parsed as { hosts: unknown[] }).hosts.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { name?: unknown }).name === name,
  );
  if (typeof host !== "object" || host === null) {
    throw new Error(`No registered host named ${name}`);
  }
  const checked = host as Partial<HostProfile>;
  if (
    typeof checked.name !== "string" ||
    typeof checked.sshTarget !== "string" ||
    typeof checked.workspacePath !== "string" ||
    (checked.allowFileSecrets !== undefined && typeof checked.allowFileSecrets !== "boolean")
  ) {
    throw new Error("Invalid registered host");
  }
  return {
    name: checked.name,
    sshTarget: checked.sshTarget,
    workspacePath: checked.workspacePath,
    ...(checked.allowFileSecrets === true ? { allowFileSecrets: true } : {}),
  };
}

async function sourceProviderKey(
  agentId: string,
): Promise<{ path: string; provider: ProviderName; value: string }> {
  if (!ID.test(agentId)) {
    throw new Error("Invalid agent id");
  }
  const agentFile = path.join(getJazzHomeDirectory(), "agents", `${agentId}.json`);
  const parsed: unknown = JSON.parse(await fs.readFile(agentFile, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("config" in parsed)) {
    throw new Error("Cannot resolve the active agent configuration");
  }
  const config = (
    parsed as { config: { llmProvider?: unknown; llmApiKeys?: Record<string, unknown> } }
  ).config;
  const provider = config?.llmProvider;
  if (typeof provider !== "string" || !isProviderName(provider)) {
    throw new Error("Cannot resolve the agent's provider");
  }
  if (provider === "ollama" || provider === "llamacpp" || provider === "vllm") {
    throw new Error(
      "Local model providers require explicit remote setup and are unavailable for detach v1",
    );
  }
  const secretPath = `llm.${provider}.api_key`;
  const fromAgent = config.llmApiKeys?.[provider];
  const backend = await Effect.runPromise(detectKeyringBackend());
  const value =
    typeof fromAgent === "string" && fromAgent.trim()
      ? fromAgent
      : (llmProviderApiKeyFromEnv(provider) ??
        (await Effect.runPromise(keyringGet(backend, secretPath))));
  if (!value) {
    throw new Error(
      `No exportable ${provider} key found. Configure it on the remote host, then retry.`,
    );
  }
  return { path: secretPath, provider, value };
}

async function agentUsesCustomTools(agentId: string): Promise<boolean> {
  const agentFile = path.join(getJazzHomeDirectory(), "agents", `${agentId}.json`);
  const parsed: unknown = JSON.parse(await fs.readFile(agentFile, "utf8"));
  const customTools = (parsed as { config?: { customTools?: unknown } }).config?.customTools;
  return Array.isArray(customTools) && customTools.length > 0;
}

/** Check host and assemble an exact snapshot for operator review. */
export async function prepareDetachTransfer(input: {
  readonly agentId: string;
  readonly conversationId: string;
  readonly history: readonly ChatMessage[];
  readonly hostName: string;
  readonly cwd: string;
  readonly continuation: string;
}): Promise<DetachPreview> {
  if (!input.continuation.trim()) {
    throw new Error("A continuation instruction is required");
  }
  const host = await registeredHost(input.hostName);
  const probe = await probeRemoteHost(host);
  const key = await sourceProviderKey(input.agentId);
  await probeRemoteProvider(host, key.provider);
  const handoffId = randomUUID();
  const bundleDirectory = stagingPath(handoffId);
  const manifest = await createDetachSnapshot({
    agentId: input.agentId,
    conversationId: input.conversationId,
    history: input.history,
    workspaceRoot: input.cwd,
    handoffId,
    bundleDirectory,
  });
  const bytes = manifest.entries.reduce((sum, entry) => sum + entry.size, 0);
  if (probe.availableBytes < bytes * 2 + 256 * 1024 * 1024) {
    throw new Error("Remote host lacks disk headroom for staging and the imported workspace");
  }
  await saveLocalTransfer({
    handoffId,
    host,
    agentId: input.agentId,
    conversationId: input.conversationId,
    state: "prepared",
  });
  return {
    handoffId,
    hostName: host.name,
    host,
    manifest,
    bytes,
    continuation: input.continuation.trim(),
    bundleDirectory,
    credentialNames: [key.path],
    warnings: [
      "Remote work uses a low-risk approval policy; higher-risk actions will park for review.",
      ...((await agentUsesCustomTools(input.agentId))
        ? ["This agent's custom tools run their commands on the host, which must provide them."]
        : []),
    ],
    approvalPolicy: "low-risk",
    maxCostUSD: DEFAULT_MAX_COST_USD,
    maxDurationMs: DEFAULT_MAX_DURATION_MS,
    maxIterations: DEFAULT_MAX_ITERATIONS,
  };
}

/** Remove an unconfirmed snapshot; no ownership was transferred during preparation. */
export async function cancelDetachTransfer(preview: DetachPreview): Promise<void> {
  await fs.rm(preview.bundleDirectory, { recursive: true, force: true });
  await fs.rm(transferPath(preview.handoffId), { force: true });
}

/** Fence local execution, transmit state, and wait for a durable remote acknowledgment. */
export async function commitDetachTransfer(preview: DetachPreview): Promise<DetachReceipt> {
  const { manifest, host, handoffId } = preview;
  await prepareDetach({
    agentId: manifest.agentId,
    conversationId: manifest.conversationId,
    handoffId,
    targetHost: host.name,
  });
  await saveLocalTransfer({
    handoffId,
    host,
    agentId: manifest.agentId,
    conversationId: manifest.conversationId,
    state: "preparing",
  });
  let remoteMayOwn = false;
  try {
    await ensureRemoteJazz(host, packageJson.version);
    const key = await sourceProviderKey(manifest.agentId);
    await transferRemoteSecret(host, key.path, key.value);
    await runRemoteHelperStream(host, "_receive", encodeDetachBundle(preview.bundleDirectory));
    remoteMayOwn = true;
    const response = await runRemoteHelper(
      host,
      "_start",
      JSON.stringify({
        handoffId,
        agentId: manifest.agentId,
        conversationId: manifest.conversationId,
        workspacePath: host.workspacePath,
        continuation: preview.continuation,
        approvalPolicy: preview.approvalPolicy,
        maxCostUSD: preview.maxCostUSD,
        maxDurationMs: preview.maxDurationMs,
        maxIterations: preview.maxIterations,
      }),
    );
    const acknowledgment: unknown = JSON.parse(response);
    if (
      typeof acknowledgment !== "object" ||
      acknowledgment === null ||
      (acknowledgment as { handoffId?: unknown }).handoffId !== handoffId ||
      (acknowledgment as { accepted?: unknown }).accepted !== true
    ) {
      throw new Error("Remote host did not acknowledge this handoff");
    }
    await commitDetach({
      agentId: manifest.agentId,
      conversationId: manifest.conversationId,
      handoffId,
    });
    await saveLocalTransfer({
      handoffId,
      host,
      agentId: manifest.agentId,
      conversationId: manifest.conversationId,
      state: "remote",
    });
    return { handoffId, hostName: host.name, state: "accepted" };
  } catch (error) {
    if (!remoteMayOwn) {
      await abortDetach({
        agentId: manifest.agentId,
        conversationId: manifest.conversationId,
        handoffId,
      });
      await cancelDetachTransfer(preview);
    }
    throw new DetachCommitError(
      error instanceof Error ? error.message : String(error),
      !remoteMayOwn,
      { cause: error },
    );
  }
}

/** Query the remote owner. SSH failure is uncertainty, never evidence of task failure. */
export async function getDetachStatus(handoffId: string): Promise<DetachStatus> {
  const record = await loadLocalTransfer(handoffId);
  if (record.state === "prepared") {
    return {
      handoffId,
      hostName: record.host.name,
      state: "preparing",
      detail: "Awaiting confirmation",
    };
  }
  if (record.state === "reclaimed") {
    return {
      handoffId,
      hostName: record.host.name,
      state: "reclaimed",
      detail: "The conversation is back on this machine.",
    };
  }
  try {
    const raw = await runRemoteHelper(record.host, "_status", JSON.stringify({ handoffId }));
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      (value as { handoffId?: unknown }).handoffId !== handoffId
    ) {
      throw new Error("Invalid remote status");
    }
    const remote = value as { state?: unknown; detail?: unknown; approvalAvailable?: unknown };
    if (
      !["preparing", "running", "parked", "completed", "failed", "released"].includes(
        String(remote.state),
      )
    ) {
      throw new Error("Invalid remote state");
    }
    return {
      handoffId,
      hostName: record.host.name,
      state: remote.state as DetachStatus["state"],
      ...(typeof remote.detail === "string" ? { detail: remote.detail } : {}),
      ...(typeof remote.approvalAvailable === "boolean"
        ? { approvalAvailable: remote.approvalAvailable }
        : {}),
    };
  } catch {
    return {
      handoffId,
      hostName: record.host.name,
      state: "unknown",
      detail: "Could not verify the remote state; local execution remains fenced.",
    };
  }
}

/** Queue an approval decision on the remote daemon and return its observed status. */
export async function answerDetachedTransfer(
  handoffId: string,
  approved: boolean,
): Promise<DetachStatus> {
  const record = await loadLocalTransfer(handoffId);
  if (record.state !== "remote") {
    throw new Error("This handoff is not remotely owned");
  }
  const raw = await runRemoteHelper(
    record.host,
    approved ? "_approve" : "_reject",
    JSON.stringify({ handoffId }),
  );
  const receipt: unknown = JSON.parse(raw);
  if (
    typeof receipt !== "object" ||
    receipt === null ||
    (receipt as { handoffId?: unknown }).handoffId !== handoffId ||
    (receipt as { accepted?: unknown }).accepted !== true
  ) {
    throw new Error("Remote host did not acknowledge the decision");
  }
  return getDetachStatus(handoffId);
}

/** Download a completed result to private staging and preview its changes without local writes. */
export async function pullDetachedTransfer(handoffId: string): Promise<DetachPullPreview> {
  const record = await loadLocalTransfer(handoffId);
  if (record.state !== "remote") {
    throw new Error("This handoff is not remotely owned");
  }
  const status = await getDetachStatus(handoffId);
  if (status.state !== "completed") {
    throw new Error("Only a completed remote run can be pulled");
  }
  const destination = path.join(getJazzHomeDirectory(), "detach", "results", handoffId);
  if (await fs.lstat(destination).catch(() => undefined)) {
    throw new Error(
      "A result is already staged for this handoff; inspect it before downloading again",
    );
  }
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const source = new PassThrough();
  try {
    await Promise.all([
      receiveDetachBundle(source, destination),
      downloadRemoteHelper(record.host, "_pull", JSON.stringify({ handoffId }), source),
    ]);
    const result = await verifyDetachSnapshot(destination);
    const initial = await verifyDetachSnapshot(stagingPath(handoffId));
    if (
      result.handoffId !== handoffId ||
      initial.handoffId !== handoffId ||
      result.agentId !== initial.agentId ||
      result.conversationId !== initial.conversationId
    ) {
      throw new Error("Result identity does not match the original handoff");
    }
    const { changedPaths, conflicts } = await compareDetachWorkspaces(initial, result);
    return {
      handoffId,
      hostName: record.host.name,
      resultDirectory: destination,
      changedPaths,
      conflicts,
    };
  } catch (error) {
    source.destroy();
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Every handoff this machine started, newest first. */
export async function listDetachTransfers(): Promise<readonly LocalTransferRecord[]> {
  const names = await fs.readdir(transfersDirectory()).catch(() => [] as string[]);
  const records: { record: LocalTransferRecord; modifiedMs: number }[] = [];
  for (const name of names) {
    const match = /^([a-zA-Z0-9_-]{1,128})\.json$/.exec(name);
    if (match?.[1] === undefined) {
      continue;
    }
    const record = await loadLocalTransfer(match[1]).catch(() => undefined);
    if (record === undefined) {
      continue;
    }
    const stat = await fs.stat(transferPath(match[1]));
    records.push({ record, modifiedMs: stat.mtimeMs });
  }
  return records
    .sort((left, right) => right.modifiedMs - left.modifiedMs)
    .map(({ record }) => record);
}

async function remoteOwnedTransfer(handoffId: string): Promise<LocalTransferRecord> {
  const record = await loadLocalTransfer(handoffId);
  if (record.state === "reclaimed") {
    throw new Error("This handoff was already reclaimed; the conversation is local again");
  }
  if (record.state !== "remote") {
    throw new Error("This handoff is not remotely owned");
  }
  return record;
}

export interface DetachEventStream {
  readonly done: Promise<void>;
  readonly stop: () => void;
}

/**
 * Stream a handoff's events from `sinceByte`, reporting the offset after each event so a
 * caller can reconnect without replaying or skipping anything.
 */
export async function followDetachedEvents(
  handoffId: string,
  sinceByte: number,
  onEvent: (event: TimedDetachEvent, nextByte: number) => void,
): Promise<DetachEventStream> {
  const record = await loadLocalTransfer(handoffId);
  if (record.state !== "remote" && record.state !== "reclaimed") {
    throw new Error("This handoff has not reached its host");
  }
  let offset = sinceByte;
  return followRemoteEvents(record.host, handoffId, sinceByte, (line, byteLength) => {
    offset += byteLength;
    const event = parseDetachEvent(line);
    if (event !== undefined) {
      onEvent(event, offset);
    }
  });
}

function requireAcknowledgment(raw: string, handoffId: string): { readonly state?: string } {
  const receipt: unknown = JSON.parse(raw);
  if (
    typeof receipt !== "object" ||
    receipt === null ||
    (receipt as { handoffId?: unknown }).handoffId !== handoffId ||
    (receipt as { accepted?: unknown }).accepted !== true
  ) {
    throw new Error("Remote host did not acknowledge the request");
  }
  const state = (receipt as { state?: unknown }).state;
  return typeof state === "string" ? { state } : {};
}

/** Send the operator's next message to a finished remote conversation. */
export async function sendDetachedMessage(handoffId: string, text: string): Promise<void> {
  const record = await remoteOwnedTransfer(handoffId);
  const raw = await runRemoteHelper(record.host, "_message", JSON.stringify({ handoffId, text }));
  requireAcknowledgment(raw, handoffId);
}

/** Cancel whatever the remote host is doing or has queued for this handoff. */
export async function stopDetachedRun(handoffId: string): Promise<void> {
  const record = await remoteOwnedTransfer(handoffId);
  const raw = await runRemoteHelper(record.host, "_cancel", JSON.stringify({ handoffId }));
  requireAcknowledgment(raw, handoffId);
}

/**
 * Take a conversation back from its host. The remote job is frozen first, so it can never run
 * again; then its final state is applied here and the local fence lifts. A failure part way
 * leaves the conversation fenced, and rerunning reclaim picks up where it stopped.
 */
export async function reclaimDetachedTransfer(
  handoffId: string,
  options: { readonly overwriteConflicts: boolean },
): Promise<DetachReclaimResult> {
  const record = await remoteOwnedTransfer(handoffId);
  const destination = path.join(
    getJazzHomeDirectory(),
    "detach",
    "results",
    `${handoffId}.reclaim`,
  );
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const source = new PassThrough();
  try {
    await Promise.all([
      receiveDetachBundle(source, destination),
      downloadRemoteHelper(record.host, "_release", JSON.stringify({ handoffId }), source),
    ]);
  } catch (error) {
    source.destroy();
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
  const outcome = await applyDetachResult({
    initialDirectory: stagingPath(handoffId),
    resultDirectory: destination,
    overwriteConflicts: options.overwriteConflicts,
  });
  const result = {
    handoffId,
    hostName: record.host.name,
    agentId: record.agentId,
    conversationId: record.conversationId,
    applied: outcome.applied,
    changedPaths: outcome.changedPaths,
    conflicts: outcome.conflicts,
  };
  if (!outcome.applied) {
    return result;
  }
  await releaseDetach({
    agentId: record.agentId,
    conversationId: record.conversationId,
    handoffId,
  });
  await saveLocalTransfer({ ...record, state: "reclaimed" });
  await fs.rm(destination, { recursive: true, force: true });
  await fs.rm(stagingPath(handoffId), { recursive: true, force: true });
  return result;
}
