/**
 * Durable, cross-process-safe plugin lifecycle state.
 *
 * Every read/validate/write transaction holds one directory mutex. State is
 * replaced atomically and an incompatible or corrupt document fails closed;
 * this module never deletes or silently resets operator trust and consent.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PluginConsentGrant } from "@jazz/core/types/plugin";
import { parsePluginManifest, type PluginManifest } from "./manifest-schema";

export const PLUGIN_STATE_SCHEMA_VERSION = 1;

/** Sentinel enablement entry meaning "every agent" — a plugin enabled globally rather than per-agent. */
export const ALL_AGENTS = "*";
const LOCK_RETRIES = 4_800;
const LOCK_RETRY_MS = 20;
// HTTPS acquisition can legitimately span several bounded redirect requests.
// Do not steal a live installer lock merely because one upstream is slow.
const STALE_LOCK_MS = 2 * 60_000;

export interface PluginLockRecord {
  readonly manifest: PluginManifest;
  readonly source: string;
  readonly artifactPath: string;
  readonly installedAt: string;
  /** "source" for a source-tree install; absent or "packed" for a bundled `.mjs` artifact. */
  readonly kind?: "packed" | "source";
}

export interface PluginStateRecord {
  readonly current: PluginLockRecord;
  readonly previous?: PluginLockRecord;
  readonly trustedDigests: readonly string[];
  readonly consentGrants: readonly PluginConsentGrant[];
  readonly enabledAgentIds: readonly string[];
  /** Enabled for every agent, including agents created later, the way MCP servers enable globally. */
  readonly enabledForAllAgents: boolean;
  /** Digests enabled at least once; retained to conservatively report restart requirements. */
  readonly activatedDigests: readonly string[];
  readonly storedSecretNames: readonly string[];
}

export interface PluginStateDocument {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly plugins: Readonly<Record<string, PluginStateRecord>>;
}

export class PluginStateError extends Error {
  constructor(
    message: string,
    readonly code: "incompatible" | "corrupt" | "lock-timeout",
  ) {
    super(message);
    this.name = "PluginStateError";
  }
}

function emptyState(): PluginStateDocument {
  return { schemaVersion: 1, revision: 0, plugins: {} };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isConsentGrantArray(value: unknown): value is readonly PluginConsentGrant[] {
  return (
    Array.isArray(value) &&
    value.every((grant) => {
      if (grant === null || typeof grant !== "object" || Array.isArray(grant)) return false;
      const item = grant as Record<string, unknown>;
      return (
        Object.keys(item).length === 2 &&
        typeof item["digest"] === "string" &&
        /^[a-f0-9]{64}$/.test(item["digest"]) &&
        typeof item["grantedAt"] === "string" &&
        Number.isFinite(Date.parse(item["grantedAt"]))
      );
    })
  );
}

/** Validate saved manifests through the same boundary used for installation. */
function parseLockRecord(
  value: unknown,
  id: string,
  slot: "current" | "previous",
): PluginLockRecord {
  const invalid = () =>
    new PluginStateError(
      `Plugin state record ${id} has an invalid ${slot} lock or manifest; retained for recovery`,
      "corrupt",
    );
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const item = value as Record<string, unknown>;
  if (
    typeof item["source"] !== "string" ||
    typeof item["artifactPath"] !== "string" ||
    typeof item["installedAt"] !== "string" ||
    (item["kind"] !== undefined && item["kind"] !== "packed" && item["kind"] !== "source")
  )
    throw invalid();
  let manifest: PluginManifest;
  try {
    manifest = parsePluginManifest(item["manifest"]);
  } catch {
    throw invalid();
  }
  if (manifest.id !== id) throw invalid();
  return {
    manifest,
    source: item["source"],
    artifactPath: item["artifactPath"],
    installedAt: item["installedAt"],
    ...(item["kind"] === undefined ? {} : { kind: item["kind"] }),
  };
}

function parseState(value: unknown): PluginStateDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginStateError("Plugin state is not a JSON object", "corrupt");
  }
  const root = value as Record<string, unknown>;
  if (root["schemaVersion"] !== PLUGIN_STATE_SCHEMA_VERSION) {
    throw new PluginStateError(
      `Unsupported plugin state schemaVersion: ${String(root["schemaVersion"])}`,
      "incompatible",
    );
  }
  if (!Number.isSafeInteger(root["revision"]) || (root["revision"] as number) < 0) {
    throw new PluginStateError("Plugin state has an invalid revision", "corrupt");
  }
  const rawPlugins = root["plugins"];
  if (rawPlugins === null || typeof rawPlugins !== "object" || Array.isArray(rawPlugins)) {
    throw new PluginStateError("Plugin state has an invalid plugins map", "corrupt");
  }
  const plugins: Record<string, PluginStateRecord> = {};
  for (const [id, value] of Object.entries(rawPlugins as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new PluginStateError(`Plugin state record ${id} is invalid`, "corrupt");
    }
    const item = value as Record<string, unknown>;
    if (
      !isStringArray(item["trustedDigests"]) ||
      !isConsentGrantArray(item["consentGrants"]) ||
      !isStringArray(item["enabledAgentIds"]) ||
      !isStringArray(item["activatedDigests"]) ||
      !isStringArray(item["storedSecretNames"])
    ) {
      throw new PluginStateError(`Plugin state record ${id} is invalid`, "corrupt");
    }
    plugins[id] = {
      current: parseLockRecord(item["current"], id, "current"),
      ...(item["previous"] === undefined
        ? {}
        : { previous: parseLockRecord(item["previous"], id, "previous") }),
      trustedDigests: item["trustedDigests"],
      consentGrants: item["consentGrants"],
      enabledAgentIds: item["enabledAgentIds"],
      enabledForAllAgents: item["enabledForAllAgents"] === true,
      activatedDigests: item["activatedDigests"],
      storedSecretNames: item["storedSecretNames"],
    };
  }
  return { schemaVersion: 1, revision: root["revision"] as number, plugins };
}

function cloneState(state: PluginStateDocument): PluginStateDocument {
  return structuredClone(state);
}

export interface PluginStateStoreOptions {
  readonly pluginDirectory: string;
}

export class PluginStateStore {
  readonly statePath: string;
  private readonly lockPath: string;

  constructor(options: PluginStateStoreOptions) {
    this.statePath = path.join(options.pluginDirectory, "state.json");
    this.lockPath = path.join(options.pluginDirectory, ".state.lock");
  }

  async read(): Promise<PluginStateDocument> {
    return this.withLock(() => this.readLocked());
  }

  async transact<T>(
    operation: (
      state: PluginStateDocument,
    ) =>
      | Promise<{ readonly state: PluginStateDocument; readonly result: T }>
      | { readonly state: PluginStateDocument; readonly result: T },
  ): Promise<T> {
    return this.withLock(async () => {
      const current = await this.readLocked();
      const outcome = await operation(cloneState(current));
      const next: PluginStateDocument = {
        ...outcome.state,
        schemaVersion: 1,
        revision: current.revision + 1,
      };
      await this.writeLocked(next);
      return outcome.result;
    });
  }

  async referencedDigests(): Promise<ReadonlySet<string>> {
    const state = await this.read();
    const digests = new Set<string>();
    for (const entry of Object.values(state.plugins)) {
      digests.add(entry.current.manifest.sha256);
      if (entry.previous) digests.add(entry.previous.manifest.sha256);
    }
    return digests;
  }

  private async readLocked(): Promise<PluginStateDocument> {
    let raw: string;
    try {
      raw = await fs.readFile(this.statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
    try {
      return parseState(JSON.parse(raw) as unknown);
    } catch (error) {
      if (error instanceof PluginStateError) throw error;
      throw new PluginStateError(
        "Plugin state contains invalid JSON; retained for recovery",
        "corrupt",
      );
    }
  }

  private async writeLocked(state: PluginStateDocument): Promise<void> {
    const directory = path.dirname(this.statePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.state-${process.pid}-${Date.now()}.tmp`);
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, this.statePath);
      await fs.chmod(this.statePath, 0o600);
      const directoryHandle = await fs.open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(this.lockPath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
      try {
        await fs.mkdir(this.lockPath, { mode: 0o700 });
        try {
          return await operation();
        } finally {
          await fs.rm(this.lockPath, { recursive: true, force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const stat = await fs.stat(this.lockPath);
          if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
            await fs.rm(this.lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS + Math.random() * 10));
      }
    }
    throw new PluginStateError(
      `Timed out acquiring plugin state lock ${this.lockPath}`,
      "lock-timeout",
    );
  }
}
