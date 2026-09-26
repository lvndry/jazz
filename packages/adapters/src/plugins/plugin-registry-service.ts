/**
 * Adapter-side executable plugin lifecycle.
 *
 * Installation never imports code. Trust and egress consent are digest-bound,
 * enablement is per agent, updates/rollback start disabled, and every mutation
 * is serialized through the state store's cross-process lock. In-process code
 * cannot be unloaded: lifecycle results truthfully report when a restart is
 * needed for already-loaded code to leave memory.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computePluginConsentDigest } from "@jazz/core/agent/plugins/consent";
import { PluginNotInstalledError } from "@jazz/core/types/errors";
import { PluginArtifactInstaller, acquirePluginManifest } from "./artifact-installer";
import {
  describeGitHubSource,
  EXCLUDED_DIRECTORIES,
  hashSourceTree,
  isLocalSourceDirectory,
  materializeGitHubSource,
  parseGitHubPluginSource,
  type GitHubPluginSource,
} from "./github-source";
import type { PluginManifest } from "./manifest-schema";
import { prepareSourceManifest } from "./plugin-author";
import { PluginSecretStore, type PluginSecretStatus } from "./secret-store";
import {
  PluginStateStore,
  type PluginLockRecord,
  type PluginStateDocument,
  type PluginStateRecord,
} from "./state-store";

export type PluginLifecycleAction =
  | "added"
  | "updated"
  | "already-current"
  | "rolled-back"
  | "trusted"
  | "consented"
  | "enabled"
  | "disabled"
  | "removed";

export interface PluginLifecycleResult {
  readonly action: PluginLifecycleAction;
  readonly pluginId: string;
  readonly digest?: string;
  readonly restartRequired: boolean;
}

export interface PluginInspection {
  readonly id: string;
  readonly current: PluginLockRecord;
  readonly previous?: PluginLockRecord;
  readonly trusted: boolean;
  readonly consented: boolean;
  readonly consentDigest: string;
  readonly enabledAgentIds: readonly string[];
  readonly enabledForAllAgents: boolean;
  readonly secrets: readonly PluginSecretStatus[];
  readonly artifactValid: boolean;
  readonly restartRequired: boolean;
}

export interface PluginDoctorReport extends PluginInspection {
  readonly healthy: boolean;
  readonly problems: readonly string[];
}

export interface PluginRegistryServiceOptions {
  readonly pluginDirectory: string;
  readonly fetchImpl?: typeof fetch;
  /** True after this process imported at least one plugin digest. */
  readonly hasLoadedDigest?: (digest: string) => boolean;
}

/** A plugin to install from source: a GitHub repo or a local directory holding a `jazz-plugin.json`. */
interface SourceSpec {
  readonly github?: GitHubPluginSource;
  readonly localDirectory?: string;
}

/** A source tree materialized and hashed on disk, ready to commit into the digest-addressed store. */
interface PreparedSource {
  readonly manifest: PluginManifest;
  readonly entry: string;
  readonly digest: string;
  readonly sourceLabel: string;
  readonly root: string;
  readonly cleanup: () => Promise<void>;
}

function recordFor(manifest: PluginManifest, source: URL, artifactPath: string): PluginLockRecord {
  return {
    manifest,
    source: source.toString(),
    artifactPath,
    installedAt: new Date().toISOString(),
  };
}

function normalized(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

export function pluginConsentDigest(manifest: PluginManifest): string {
  return computePluginConsentDigest(manifest);
}

/**
 * Resolve a user-supplied identifier to an installed plugin id: an exact id, or the `owner/repo`
 * (or github URL) the plugin was installed from, matched against its recorded source. Lets the
 * management commands accept the same identifier used with `add`.
 */
function resolveInstalledId(state: PluginStateDocument, given: string): string | undefined {
  if (state.plugins[given]) {
    return given;
  }
  const github = parseGitHubPluginSource(given);
  if (github === undefined) {
    return undefined;
  }
  // A ref-qualified source resolves only to that exact ref; an unqualified one resolves to any ref
  // installed from the repo. Fail closed when the alias is ambiguous rather than picking the first.
  const base = `github:${github.owner}/${github.repo}`;
  const canonical = describeGitHubSource(github);
  const matches = Object.entries(state.plugins).filter(([, record]) =>
    github.ref === undefined
      ? record.current.source === base || record.current.source.startsWith(`${base}@`)
      : record.current.source === canonical,
  );
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length > 1) {
    const ids = matches
      .map(([id]) => id)
      .sort()
      .join(", ");
    throw new Error(`Plugin source ${given} is ambiguous across installed plugins: ${ids}`);
  }
  return matches[0]?.[0];
}

function requireEntry(state: PluginStateDocument, id: string): PluginStateRecord {
  const resolved = resolveInstalledId(state, id);
  const entry = resolved === undefined ? undefined : state.plugins[resolved];
  if (!entry) {
    throw new PluginNotInstalledError({ pluginId: id });
  }
  return entry;
}

function replaceEntry(
  state: PluginStateDocument,
  id: string,
  entry: PluginStateRecord | undefined,
): PluginStateDocument {
  const plugins = { ...state.plugins };
  if (entry === undefined) delete plugins[id];
  else plugins[id] = entry;
  return { ...state, plugins };
}

export class PluginRegistryServiceImpl {
  readonly stateStore: PluginStateStore;
  readonly installer: PluginArtifactInstaller;
  readonly secrets: PluginSecretStore;

  constructor(private readonly options: PluginRegistryServiceOptions) {
    this.stateStore = new PluginStateStore({ pluginDirectory: options.pluginDirectory });
    this.installer = new PluginArtifactInstaller({
      pluginDirectory: options.pluginDirectory,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    this.secrets = new PluginSecretStore();
  }

  async add(source: string | URL): Promise<PluginLifecycleResult> {
    const acquired = await acquirePluginManifest(source, this.options.fetchImpl);
    return this.stateStore.transact(async (state) => {
      if (state.plugins[acquired.manifest.id]) {
        throw new Error(`Plugin is already installed: ${acquired.manifest.id}`);
      }
      const artifactPath = await this.installer.install(acquired.manifest, acquired.source);
      const entry: PluginStateRecord = {
        current: recordFor(acquired.manifest, acquired.source, artifactPath),
        trustedDigests: [],
        consentGrants: [],
        enabledAgentIds: [],
        enabledForAllAgents: false,
        activatedDigests: [],
        storedSecretNames: [],
      };
      return {
        state: replaceEntry(state, acquired.manifest.id, entry),
        result: {
          action: "added" as const,
          pluginId: acquired.manifest.id,
          digest: acquired.manifest.sha256,
          restartRequired: false,
        },
      };
    });
  }

  /**
   * Install a plugin from a source repository — a GitHub `owner/repo` (downloaded over HTTPS, no
   * local `git`) or a local directory holding a `jazz-plugin.json`. The source tree is hashed and
   * that hash is the digest the operator trusts; no code is bundled or executed. The plugin lands
   * untrusted and disabled.
   */
  async addFromSource(spec: SourceSpec): Promise<PluginLifecycleResult> {
    const prepared = await this.materializeSource(spec);
    try {
      return await this.stateStore.transact(async (state) => {
        if (state.plugins[prepared.manifest.id]) {
          throw new Error(`Plugin is already installed: ${prepared.manifest.id}`);
        }
        const committed = await this.installer.commitSourceTree(prepared.root, prepared.digest);
        const record: PluginStateRecord = {
          current: {
            manifest: prepared.manifest,
            source: prepared.sourceLabel,
            artifactPath: path.join(committed, prepared.entry),
            installedAt: new Date().toISOString(),
            kind: "source",
          },
          trustedDigests: [],
          consentGrants: [],
          enabledAgentIds: [],
          enabledForAllAgents: false,
          activatedDigests: [],
          storedSecretNames: [],
        };
        return {
          state: replaceEntry(state, prepared.manifest.id, record),
          result: {
            action: "added" as const,
            pluginId: prepared.manifest.id,
            digest: prepared.digest,
            restartRequired: false,
          },
        };
      });
    } finally {
      await prepared.cleanup();
    }
  }

  /**
   * Update a plugin, re-fetching from its source when it was installed from one. `source` may be a
   * GitHub `owner/repo`, a github URL, or a local source directory; a packed manifest path/URL keeps
   * the bundled-artifact path. The CLI defaults `source` to the plugin's recorded source, so
   * `jazz plugin update owner/repo` re-pulls the same repo.
   */
  async update(id: string, source: string | URL): Promise<PluginLifecycleResult> {
    const spec = await this.sourceSpecFor(source);
    if (spec !== undefined) {
      return this.updateFromSource(id, spec);
    }
    const acquired = await acquirePluginManifest(source, this.options.fetchImpl);
    return this.stateStore.transact<PluginLifecycleResult>(async (state) => {
      const existing = requireEntry(state, id);
      const pluginId = existing.current.manifest.id;
      if (acquired.manifest.id !== pluginId) {
        throw new Error(`Update id mismatch: expected ${pluginId}`);
      }
      if (existing.current.manifest.sha256 === acquired.manifest.sha256) {
        return {
          state,
          result: {
            action: "already-current" as const,
            pluginId,
            digest: acquired.manifest.sha256,
            restartRequired: false,
          },
        };
      }
      const artifactPath = await this.installer.install(acquired.manifest, acquired.source);
      const entry: PluginStateRecord = {
        ...existing,
        current: recordFor(acquired.manifest, acquired.source, artifactPath),
        previous: existing.current,
        enabledAgentIds: [],
        enabledForAllAgents: false,
      };
      return {
        state: replaceEntry(state, pluginId, entry),
        result: {
          action: "updated" as const,
          pluginId,
          digest: acquired.manifest.sha256,
          restartRequired: this.wasLoaded(existing.current.manifest.sha256),
        },
      };
    });
  }

  private async updateFromSource(id: string, spec: SourceSpec): Promise<PluginLifecycleResult> {
    const prepared = await this.materializeSource(spec);
    try {
      return await this.stateStore.transact<PluginLifecycleResult>(async (state) => {
        const existing = requireEntry(state, id);
        const pluginId = existing.current.manifest.id;
        if (prepared.manifest.id !== pluginId) {
          throw new Error(`Update id mismatch: expected ${pluginId}`);
        }
        if (existing.current.manifest.sha256 === prepared.digest) {
          return {
            state,
            result: {
              action: "already-current" as const,
              pluginId,
              digest: prepared.digest,
              restartRequired: false,
            },
          };
        }
        const committed = await this.installer.commitSourceTree(prepared.root, prepared.digest);
        const record: PluginStateRecord = {
          ...existing,
          current: {
            manifest: prepared.manifest,
            source: prepared.sourceLabel,
            artifactPath: path.join(committed, prepared.entry),
            installedAt: new Date().toISOString(),
            kind: "source",
          },
          previous: existing.current,
          enabledAgentIds: [],
        };
        return {
          state: replaceEntry(state, pluginId, record),
          result: {
            action: "updated" as const,
            pluginId,
            digest: prepared.digest,
            restartRequired: this.wasLoaded(existing.current.manifest.sha256),
          },
        };
      });
    } finally {
      await prepared.cleanup();
    }
  }

  /** Classify an update/install source: a GitHub or local-directory source, or undefined for packed. */
  private async sourceSpecFor(source: string | URL): Promise<SourceSpec | undefined> {
    const text = typeof source === "string" ? source : source.toString();
    const github = parseGitHubPluginSource(text);
    if (github !== undefined) {
      return { github };
    }
    const candidate = text.startsWith("file://") ? fileURLToPath(text) : text;
    if (await isLocalSourceDirectory(candidate)) {
      return { localDirectory: path.resolve(candidate) };
    }
    return undefined;
  }

  /** Fetch and hash a source tree into a temp/local dir, ready to commit. Caller runs cleanup(). */
  private async materializeSource(spec: SourceSpec): Promise<PreparedSource> {
    // Always work in a private snapshot so the tree that is hashed is exactly the tree that is
    // committed. A GitHub source is downloaded into it; a local directory is copied into it, so a
    // concurrent edit to the user's directory cannot make the recorded digest diverge from the
    // committed bytes.
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-src-"));
    const cleanup = async (): Promise<void> => {
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    };
    try {
      let sourceLabel: string;
      if (spec.github) {
        await materializeGitHubSource(spec.github, temporary, this.options.fetchImpl);
        sourceLabel = describeGitHubSource(spec.github);
      } else if (spec.localDirectory !== undefined) {
        await fs.cp(spec.localDirectory, temporary, {
          recursive: true,
          dereference: false,
          errorOnExist: false,
          filter: (candidate) => !EXCLUDED_DIRECTORIES.has(path.basename(candidate)),
        });
        sourceLabel = pathToFileURL(path.resolve(spec.localDirectory)).toString();
      } else {
        throw new Error("A source install requires a GitHub source or a local directory");
      }
      const digest = await hashSourceTree(temporary);
      const { manifest, entry } = await prepareSourceManifest(temporary, digest);
      return { manifest, entry, digest, sourceLabel, root: temporary, cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  async rollback(id: string): Promise<PluginLifecycleResult> {
    return this.stateStore.transact((state) => {
      const existing = requireEntry(state, id);
      const pluginId = existing.current.manifest.id;
      if (!existing.previous) throw new Error(`Plugin ${id} has no rollback artifact`);
      const entry: PluginStateRecord = {
        ...existing,
        current: existing.previous,
        previous: existing.current,
        enabledAgentIds: [],
        enabledForAllAgents: false,
      };
      return {
        state: replaceEntry(state, pluginId, entry),
        result: {
          action: "rolled-back" as const,
          pluginId,
          digest: entry.current.manifest.sha256,
          restartRequired: this.wasLoaded(existing.current.manifest.sha256),
        },
      };
    });
  }

  async trust(id: string, expectedDigest: string): Promise<PluginLifecycleResult> {
    return this.stateStore.transact((state) => {
      const existing = requireEntry(state, id);
      const pluginId = existing.current.manifest.id;
      if (existing.current.manifest.sha256 !== expectedDigest) {
        throw new Error(`Plugin digest changed; inspect ${id} and acknowledge the current digest`);
      }
      const entry = {
        ...existing,
        trustedDigests: normalized([...existing.trustedDigests, expectedDigest]),
      };
      return {
        state: replaceEntry(state, pluginId, entry),
        result: {
          action: "trusted" as const,
          pluginId,
          digest: expectedDigest,
          restartRequired: false,
        },
      };
    });
  }

  async grantConsent(id: string, expectedConsentDigest: string): Promise<PluginLifecycleResult> {
    return this.stateStore.transact((state) => {
      const existing = requireEntry(state, id);
      const pluginId = existing.current.manifest.id;
      const actual = pluginConsentDigest(existing.current.manifest);
      if (actual !== expectedConsentDigest) {
        throw new Error(`Plugin consent declaration changed; inspect ${id} again`);
      }
      const consentGrants = existing.consentGrants.some((grant) => grant.digest === actual)
        ? existing.consentGrants
        : [...existing.consentGrants, { digest: actual, grantedAt: new Date().toISOString() }];
      const entry = { ...existing, consentGrants };
      return {
        state: replaceEntry(state, pluginId, entry),
        result: {
          action: "consented" as const,
          pluginId,
          digest: actual,
          restartRequired: false,
        },
      };
    });
  }

  async enable(id: string, agentId?: string): Promise<PluginLifecycleResult> {
    if (agentId !== undefined && agentId.trim().length === 0) {
      throw new Error("agentId cannot be empty");
    }
    return this.stateStore.transact((state) => {
      const existing = requireEntry(state, id);
      const pluginId = existing.current.manifest.id;
      const digest = existing.current.manifest.sha256;
      if (!existing.trustedDigests.includes(digest)) throw new Error(`Plugin ${id} is not trusted`);
      if (
        !existing.consentGrants.some(
          (grant) => grant.digest === pluginConsentDigest(existing.current.manifest),
        )
      ) {
        throw new Error(`Plugin ${id} does not have current egress consent`);
      }
      // A plugin enabled for all agents runs everywhere, so it conflicts with any other plugin that
      // shares a hook and is active anywhere; a per-agent enable conflicts with another plugin that
      // is enabled for that agent or for all agents. One handler per hook, either way.
      const conflicts: string[] = [];
      for (const [otherId, other] of Object.entries(state.plugins)) {
        if (otherId === pluginId) continue;
        const otherActiveHere =
          agentId === undefined
            ? other.enabledForAllAgents || other.enabledAgentIds.length > 0
            : other.enabledForAllAgents || other.enabledAgentIds.includes(agentId);
        if (!otherActiveHere) continue;
        const advisoryOverlap = other.current.manifest.hooks.filter((hook) =>
          existing.current.manifest.hooks.includes(hook),
        );
        const policyOverlap = other.current.manifest.policyHooks.filter((hook) =>
          existing.current.manifest.policyHooks.includes(hook),
        );
        const overlap = [...advisoryOverlap, ...policyOverlap];
        if (overlap.length > 0) conflicts.push(`${otherId} (${overlap.join(", ")})`);
      }
      if (conflicts.length > 0) {
        const scope = agentId === undefined ? "all agents" : `agent ${agentId}`;
        throw new Error(`Plugin hook conflict for ${scope}: ${conflicts.join("; ")}`);
      }
      const entry = {
        ...existing,
        enabledAgentIds:
          agentId === undefined
            ? existing.enabledAgentIds
            : normalized([...existing.enabledAgentIds, agentId]),
        enabledForAllAgents: agentId === undefined ? true : existing.enabledForAllAgents,
        activatedDigests: normalized([...existing.activatedDigests, digest]),
      };
      return {
        state: replaceEntry(state, pluginId, entry),
        result: { action: "enabled" as const, pluginId, digest, restartRequired: false },
      };
    });
  }

  async disable(id: string, agentId?: string): Promise<PluginLifecycleResult> {
    return this.stateStore.transact((state) => {
      const existing = requireEntry(state, id);
      const pluginId = existing.current.manifest.id;
      const enabledAgentIds = agentId
        ? existing.enabledAgentIds.filter((candidate) => candidate !== agentId)
        : [];
      const enabledForAllAgents = agentId ? existing.enabledForAllAgents : false;
      return {
        state: replaceEntry(state, pluginId, { ...existing, enabledAgentIds, enabledForAllAgents }),
        result: {
          action: "disabled" as const,
          pluginId,
          digest: existing.current.manifest.sha256,
          restartRequired:
            existing.activatedDigests.includes(existing.current.manifest.sha256) ||
            this.wasLoaded(existing.current.manifest.sha256),
        },
      };
    });
  }

  async remove(
    id: string,
    options?: { readonly keepSecrets?: boolean },
  ): Promise<PluginLifecycleResult> {
    let removed: PluginStateRecord | undefined;
    let pluginId = id;
    const result = await this.stateStore.transact((state) => {
      removed = requireEntry(state, id);
      pluginId = removed.current.manifest.id;
      return {
        state: replaceEntry(state, pluginId, undefined),
        result: {
          action: "removed" as const,
          pluginId,
          digest: removed.current.manifest.sha256,
          restartRequired:
            removed.activatedDigests.length > 0 ||
            this.wasLoaded(removed.current.manifest.sha256) ||
            (removed.previous ? this.wasLoaded(removed.previous.manifest.sha256) : false),
        },
      };
    });
    if (!options?.keepSecrets && removed) {
      const names = normalized([
        ...removed.storedSecretNames,
        ...removed.current.manifest.secrets.map((secret) => secret.name),
        ...(removed.previous?.manifest.secrets.map((secret) => secret.name) ?? []),
      ]);
      await Promise.all(names.map((name) => this.secrets.delete(pluginId, name)));
    }
    await this.gc();
    return result;
  }

  async setSecret(id: string, name: string, value: string): Promise<boolean> {
    const state = await this.stateStore.read();
    const entry = requireEntry(state, id);
    const pluginId = entry.current.manifest.id;
    if (!entry.current.manifest.secrets.some((secret) => secret.name === name)) {
      throw new Error(`Plugin ${pluginId} did not declare secret ${name}`);
    }
    const stored = await this.secrets.set(pluginId, name, value);
    if (stored) {
      await this.stateStore.transact((latest) => {
        const current = requireEntry(latest, id);
        return {
          state: replaceEntry(latest, current.current.manifest.id, {
            ...current,
            storedSecretNames: normalized([...current.storedSecretNames, name]),
          }),
          result: undefined,
        };
      });
    }
    return stored;
  }

  async deleteSecret(id: string, name: string): Promise<void> {
    const state = await this.stateStore.read();
    const pluginId = requireEntry(state, id).current.manifest.id;
    await this.secrets.delete(pluginId, name);
    await this.stateStore.transact((latest) => {
      const entry = requireEntry(latest, id);
      return {
        state: replaceEntry(latest, entry.current.manifest.id, {
          ...entry,
          storedSecretNames: entry.storedSecretNames.filter((candidate) => candidate !== name),
        }),
        result: undefined,
      };
    });
  }

  async inspect(id: string): Promise<PluginInspection> {
    const state = await this.stateStore.read();
    const entry = requireEntry(state, id);
    const digest = entry.current.manifest.sha256;
    const pluginId = entry.current.manifest.id;
    const consentDigest = pluginConsentDigest(entry.current.manifest);
    return {
      id: pluginId,
      current: entry.current,
      ...(entry.previous ? { previous: entry.previous } : {}),
      trusted: entry.trustedDigests.includes(digest),
      consented: entry.consentGrants.some((grant) => grant.digest === consentDigest),
      consentDigest,
      enabledAgentIds: entry.enabledAgentIds,
      enabledForAllAgents: entry.enabledForAllAgents,
      secrets: await Promise.all(
        entry.current.manifest.secrets.map((secret) => this.secrets.status(pluginId, secret)),
      ),
      artifactValid: await this.verifyInstalled(entry.current),
      restartRequired: this.wasLoaded(digest),
    };
  }

  async list(): Promise<readonly PluginInspection[]> {
    const state = await this.stateStore.read();
    return Promise.all(
      Object.keys(state.plugins)
        .sort()
        .map((id) => this.inspect(id)),
    );
  }

  async doctor(id: string): Promise<PluginDoctorReport> {
    const inspection = await this.inspect(id);
    const problems: string[] = [];
    if (!inspection.artifactValid) problems.push("artifact digest is missing or invalid");
    if (!inspection.trusted) problems.push("current code digest is not trusted");
    if (!inspection.consented) problems.push("current capabilities do not have consent");
    for (const secret of inspection.secrets) {
      if (secret.required && (secret.source === "missing" || secret.source === "unavailable")) {
        problems.push(`required secret ${secret.name} is ${secret.source}`);
      }
    }
    return { ...inspection, healthy: problems.length === 0, problems };
  }

  async gc(): Promise<readonly string[]> {
    return this.stateStore.transact(async (state) => {
      const referenced = new Set<string>();
      for (const entry of Object.values(state.plugins)) {
        referenced.add(entry.current.manifest.sha256);
        if (entry.previous) referenced.add(entry.previous.manifest.sha256);
      }
      const removed: string[] = [];
      const collect = async (
        directory: string,
        remove: (digest: string) => Promise<void>,
      ): Promise<void> => {
        for (const item of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
          if (!item.isDirectory() || item.name.startsWith(".")) continue;
          if (
            !/^[a-f0-9]{64}$/.test(item.name) ||
            referenced.has(item.name) ||
            this.wasLoaded(item.name)
          ) {
            continue;
          }
          await remove(item.name);
          removed.push(item.name);
        }
      };
      await collect(path.join(this.options.pluginDirectory, "artifacts"), (digest) =>
        this.installer.removeDigest(digest),
      );
      await collect(path.join(this.options.pluginDirectory, "sources"), (digest) =>
        this.installer.removeSource(digest),
      );
      return { state, result: removed };
    });
  }

  private wasLoaded(digest: string): boolean {
    return this.options.hasLoadedDigest?.(digest) === true;
  }

  /** Verify an installed plugin against its digest: a source-tree hash, or a bundled-artifact hash. */
  private async verifyInstalled(record: PluginLockRecord): Promise<boolean> {
    if (record.kind === "source") {
      try {
        return (
          (await hashSourceTree(this.installer.sourcePath(record.manifest.sha256))) ===
          record.manifest.sha256
        );
      } catch {
        return false;
      }
    }
    return this.installer.verify(record.manifest.sha256);
  }
}
