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
import * as path from "node:path";
import { computePluginConsentDigest } from "@jazz/core/agent/plugins/consent";
import { PluginArtifactInstaller, acquirePluginManifest } from "./artifact-installer";
import type { PluginManifest } from "./manifest-schema";
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

function requireEntry(state: PluginStateDocument, id: string): PluginStateRecord {
  const entry = state.plugins[id];
  if (!entry) throw new Error(`Plugin is not installed: ${id}`);
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

  async update(id: string, source: string | URL): Promise<PluginLifecycleResult> {
    const acquired = await acquirePluginManifest(source, this.options.fetchImpl);
    if (acquired.manifest.id !== id) throw new Error(`Update id mismatch: expected ${id}`);
    return this.stateStore.transact(async (state) => {
      const existing = requireEntry(state, id);
      if (existing.current.manifest.sha256 === acquired.manifest.sha256) {
        throw new Error(`Plugin ${id} is already at digest ${acquired.manifest.sha256}`);
      }
      const artifactPath = await this.installer.install(acquired.manifest, acquired.source);
      const entry: PluginStateRecord = {
        ...existing,
        current: recordFor(acquired.manifest, acquired.source, artifactPath),
        previous: existing.current,
        enabledAgentIds: [],
      };
      return {
        state: replaceEntry(state, id, entry),
        result: {
          action: "updated" as const,
          pluginId: id,
          digest: acquired.manifest.sha256,
          restartRequired: this.wasLoaded(existing.current.manifest.sha256),
        },
      };
    });
  }

  async rollback(id: string): Promise<PluginLifecycleResult> {
    return this.stateStore.transact((state) => {
      const existing = requireEntry(state, id);
      if (!existing.previous) throw new Error(`Plugin ${id} has no rollback artifact`);
      const entry: PluginStateRecord = {
        ...existing,
        current: existing.previous,
        previous: existing.current,
        enabledAgentIds: [],
      };
      return {
        state: replaceEntry(state, id, entry),
        result: {
          action: "rolled-back" as const,
          pluginId: id,
          digest: entry.current.manifest.sha256,
          restartRequired: this.wasLoaded(existing.current.manifest.sha256),
        },
      };
    });
  }

  async trust(id: string, expectedDigest: string): Promise<PluginLifecycleResult> {
    return this.stateStore.transact((state) => {
      const existing = requireEntry(state, id);
      if (existing.current.manifest.sha256 !== expectedDigest) {
        throw new Error(`Plugin digest changed; inspect ${id} and acknowledge the current digest`);
      }
      const entry = {
        ...existing,
        trustedDigests: normalized([...existing.trustedDigests, expectedDigest]),
      };
      return {
        state: replaceEntry(state, id, entry),
        result: {
          action: "trusted" as const,
          pluginId: id,
          digest: expectedDigest,
          restartRequired: false,
        },
      };
    });
  }

  async grantConsent(id: string, expectedConsentDigest: string): Promise<PluginLifecycleResult> {
    return this.stateStore.transact((state) => {
      const existing = requireEntry(state, id);
      const actual = pluginConsentDigest(existing.current.manifest);
      if (actual !== expectedConsentDigest) {
        throw new Error(`Plugin consent declaration changed; inspect ${id} again`);
      }
      const consentGrants = existing.consentGrants.some((grant) => grant.digest === actual)
        ? existing.consentGrants
        : [...existing.consentGrants, { digest: actual, grantedAt: new Date().toISOString() }];
      const entry = { ...existing, consentGrants };
      return {
        state: replaceEntry(state, id, entry),
        result: {
          action: "consented" as const,
          pluginId: id,
          digest: actual,
          restartRequired: false,
        },
      };
    });
  }

  async enable(id: string, agentId: string): Promise<PluginLifecycleResult> {
    if (agentId.trim().length === 0) throw new Error("agentId cannot be empty");
    return this.stateStore.transact((state) => {
      const existing = requireEntry(state, id);
      const digest = existing.current.manifest.sha256;
      if (!existing.trustedDigests.includes(digest)) throw new Error(`Plugin ${id} is not trusted`);
      if (
        !existing.consentGrants.some(
          (grant) => grant.digest === pluginConsentDigest(existing.current.manifest),
        )
      ) {
        throw new Error(`Plugin ${id} does not have current egress consent`);
      }
      const conflicts: string[] = [];
      for (const [otherId, other] of Object.entries(state.plugins)) {
        if (otherId === id || !other.enabledAgentIds.includes(agentId)) continue;
        const overlap = other.current.manifest.hooks.filter((hook) =>
          existing.current.manifest.hooks.includes(hook),
        );
        if (overlap.length > 0) conflicts.push(`${otherId} (${overlap.join(", ")})`);
      }
      if (conflicts.length > 0)
        throw new Error(`Plugin hook conflict for agent ${agentId}: ${conflicts.join("; ")}`);
      const entry = {
        ...existing,
        enabledAgentIds: normalized([...existing.enabledAgentIds, agentId]),
        activatedDigests: normalized([...existing.activatedDigests, digest]),
      };
      return {
        state: replaceEntry(state, id, entry),
        result: { action: "enabled" as const, pluginId: id, digest, restartRequired: false },
      };
    });
  }

  async disable(id: string, agentId?: string): Promise<PluginLifecycleResult> {
    return this.stateStore.transact((state) => {
      const existing = requireEntry(state, id);
      const enabledAgentIds = agentId
        ? existing.enabledAgentIds.filter((candidate) => candidate !== agentId)
        : [];
      return {
        state: replaceEntry(state, id, { ...existing, enabledAgentIds }),
        result: {
          action: "disabled" as const,
          pluginId: id,
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
    const result = await this.stateStore.transact((state) => {
      removed = requireEntry(state, id);
      return {
        state: replaceEntry(state, id, undefined),
        result: {
          action: "removed" as const,
          pluginId: id,
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
      await Promise.all(names.map((name) => this.secrets.delete(id, name)));
    }
    await this.gc();
    return result;
  }

  async setSecret(id: string, name: string, value: string): Promise<boolean> {
    const state = await this.stateStore.read();
    const entry = requireEntry(state, id);
    if (!entry.current.manifest.secrets.some((secret) => secret.name === name)) {
      throw new Error(`Plugin ${id} did not declare secret ${name}`);
    }
    const stored = await this.secrets.set(id, name, value);
    if (stored) {
      await this.stateStore.transact((latest) => {
        const current = requireEntry(latest, id);
        return {
          state: replaceEntry(latest, id, {
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
    await this.secrets.delete(id, name);
    await this.stateStore.transact((state) => {
      const entry = requireEntry(state, id);
      return {
        state: replaceEntry(state, id, {
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
    const consentDigest = pluginConsentDigest(entry.current.manifest);
    return {
      id,
      current: entry.current,
      ...(entry.previous ? { previous: entry.previous } : {}),
      trusted: entry.trustedDigests.includes(digest),
      consented: entry.consentGrants.some((grant) => grant.digest === consentDigest),
      consentDigest,
      enabledAgentIds: entry.enabledAgentIds,
      secrets: await Promise.all(
        entry.current.manifest.secrets.map((secret) => this.secrets.status(id, secret)),
      ),
      artifactValid: await this.installer.verify(digest),
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
      const artifacts = path.join(this.options.pluginDirectory, "artifacts");
      const removed: string[] = [];
      for (const item of await fs.readdir(artifacts, { withFileTypes: true }).catch(() => [])) {
        if (!item.isDirectory() || item.name.startsWith(".")) continue;
        if (
          !/^[a-f0-9]{64}$/.test(item.name) ||
          referenced.has(item.name) ||
          this.wasLoaded(item.name)
        ) {
          continue;
        }
        await this.installer.removeDigest(item.name);
        removed.push(item.name);
      }
      return { state, result: removed };
    });
  }

  private wasLoaded(digest: string): boolean {
    return this.options.hasLoadedDigest?.(digest) === true;
  }
}
