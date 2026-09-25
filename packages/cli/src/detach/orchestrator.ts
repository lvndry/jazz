/**
 * Operator initiated conversation handoff to a registered SSH host.
 *
 * Preparation is read-only with respect to conversation ownership. Commit fences the local
 * conversation before sending a verified snapshot. A failure after remote start is ambiguous:
 * the local fence stays in place and status must reconcile by the same handoff id.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import {
  ensureRemoteJazz,
  downloadRemoteHelper,
  probeRemoteHost,
  probeRemoteProvider,
  runRemoteHelper,
  runRemoteHelperStream,
  transferRemoteSecret,
} from "@jazz/adapters/detach/remote-host";
import {
  createDetachSnapshot,
  verifyDetachSnapshot,
  type DetachManifest,
} from "@jazz/adapters/detach/snapshot";
import { encodeDetachBundle, receiveDetachBundle } from "@jazz/adapters/detach/transfer-protocol";
import { detectKeyringBackend, keyringGet } from "@jazz/adapters/secrets/keyring";
import { llmProviderApiKeyFromEnv } from "@jazz/adapters/secrets/registry";
import { abortDetach, commitDetach, prepareDetach } from "@jazz/core/agent/detach/ownership";
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
  readonly state: "preparing" | "running" | "parked" | "completed" | "failed" | "unknown";
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

interface LocalTransferRecord {
  readonly handoffId: string;
  readonly host: HostProfile;
  readonly agentId: string;
  readonly conversationId: string;
  readonly state: "prepared" | "preparing" | "remote";
}

function transferPath(id: string): string {
  if (!ID.test(id)) throw new Error("Invalid handoff id");
  return path.join(getJazzHomeDirectory(), "detach", "transfers", `${id}.json`);
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
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("Invalid local handoff record");
  const value = parsed as Record<string, unknown>;
  const host = value["host"];
  if (
    value["handoffId"] !== handoffId ||
    typeof value["agentId"] !== "string" ||
    typeof value["conversationId"] !== "string" ||
    !["prepared", "preparing", "remote"].includes(String(value["state"])) ||
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
  if (typeof host !== "object" || host === null)
    throw new Error(`No registered host named ${name}`);
  const checked = host as Partial<HostProfile>;
  if (
    typeof checked.name !== "string" ||
    typeof checked.sshTarget !== "string" ||
    typeof checked.workspacePath !== "string"
  )
    throw new Error("Invalid registered host");
  return checked as HostProfile;
}

async function sourceProviderKey(
  agentId: string,
): Promise<{ path: string; provider: ProviderName; value: string }> {
  if (!ID.test(agentId)) throw new Error("Invalid agent id");
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
  if (!value)
    throw new Error(
      `No exportable ${provider} key found. Configure it on the remote host, then retry.`,
    );
  return { path: secretPath, provider, value };
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
  if (!input.continuation.trim()) throw new Error("A continuation instruction is required");
  const host = await registeredHost(input.hostName);
  const probe = await probeRemoteHost(host);
  const key = await sourceProviderKey(input.agentId);
  await probeRemoteProvider(host, key.provider);
  const handoffId = randomUUID();
  const bundleDirectory = path.join(getJazzHomeDirectory(), "detach", "staging", handoffId);
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
  try {
    const raw = await runRemoteHelper(record.host, "_status", JSON.stringify({ handoffId }));
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      (value as { handoffId?: unknown }).handoffId !== handoffId
    )
      throw new Error("Invalid remote status");
    const remote = value as { state?: unknown; detail?: unknown; approvalAvailable?: unknown };
    if (!["preparing", "running", "parked", "completed", "failed"].includes(String(remote.state))) {
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
  if (record.state !== "remote") throw new Error("This handoff is not remotely owned");
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

async function fileHash(file: string): Promise<string | undefined> {
  const stat = await fs.lstat(file).catch(() => undefined);
  if (!stat) return undefined;
  if (!stat.isFile()) return "non-regular";
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Download a completed result to private staging and preview its changes without local writes. */
export async function pullDetachedTransfer(handoffId: string): Promise<DetachPullPreview> {
  const record = await loadLocalTransfer(handoffId);
  if (record.state !== "remote") throw new Error("This handoff is not remotely owned");
  const status = await getDetachStatus(handoffId);
  if (status.state !== "completed") throw new Error("Only a completed remote run can be pulled");
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
    const initial = await verifyDetachSnapshot(
      path.join(getJazzHomeDirectory(), "detach", "staging", handoffId),
    );
    if (
      result.handoffId !== handoffId ||
      initial.handoffId !== handoffId ||
      result.agentId !== initial.agentId ||
      result.conversationId !== initial.conversationId
    ) {
      throw new Error("Result identity does not match the original handoff");
    }
    const workspaceEntries = (manifest: DetachManifest): Map<string, string> =>
      new Map(
        manifest.entries
          .filter((entry) => entry.kind === "workspace")
          .map((entry) => [entry.relativePath.slice("workspace/".length), entry.sha256]),
      );
    const before = workspaceEntries(initial);
    const after = workspaceEntries(result);
    const paths = new Set([...before.keys(), ...after.keys()]);
    const changedPaths = [...paths]
      .filter((relative) => before.get(relative) !== after.get(relative))
      .sort();
    const conflicts: string[] = [];
    for (const relative of changedPaths) {
      const current = await fileHash(path.join(initial.workspaceRoot, relative));
      if (current !== before.get(relative)) conflicts.push(relative);
    }
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
