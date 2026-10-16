/**
 * Consent-gated verification and import of plugin modules.
 *
 * This boundary deliberately does not register plugins or construct a host API.
 * Core owns registration and per-run isolation; the adapter only turns enabled,
 * digest-verified artifacts into the `LoadedPlugin` values core accepts.
 */

import { pathToFileURL } from "node:url";
import type { JazzPluginModule, LoadedPlugin, PluginManifest } from "@jazz/core/types/plugin";
import { toError } from "@jazz/core/utils/errors";
import { isRecord } from "@jazz/core/utils/is-record";
import type { PluginArtifactInstaller } from "./artifact-installer";
import { hookConflicts, pluginConsentDigest } from "./plugin-registry-service";
import { verifySourceInstall } from "./source-integrity";
import {
  ALL_AGENTS,
  type PluginLockRecord,
  type PluginStateRecord,
  type PluginStateStore,
} from "./state-store";

export interface PluginModuleLoaderOptions {
  readonly stateStore: PluginStateStore;
  readonly installer: PluginArtifactInstaller;
}

export interface EnabledPluginSnapshot {
  readonly id: string;
  readonly digest: string;
}

function isPluginModule(value: unknown): value is JazzPluginModule {
  if (!isRecord(value)) return false;
  const item = value;
  return (
    item["apiVersion"] === 1 &&
    typeof item["register"] === "function" &&
    (item["dispose"] === undefined || typeof item["dispose"] === "function")
  );
}

function assertAuthorized(pluginId: string, record: PluginStateRecord): void {
  const { manifest } = record.current;
  if (!record.trustedDigests.includes(manifest.sha256)) {
    throw new Error(`Plugin ${pluginId} current digest is not trusted`);
  }
  if (!record.consentGrants.some((grant) => grant.digest === pluginConsentDigest(manifest))) {
    throw new Error(`Plugin ${pluginId} current capabilities do not have consent`);
  }
}

function enabledInState(record: PluginStateRecord, agentId: string): boolean {
  return (
    record.enabledForAllAgents ||
    record.enabledAgentIds.includes(agentId) ||
    record.enabledAgentIds.includes(ALL_AGENTS)
  );
}

export class PluginModuleLoader {
  private readonly loaded = new Set<string>();
  /**
   * Plugins turned on or off for the open conversation only, by plugin id. They win over the saved
   * enablement for every agent in this process and are never written to the state file.
   */
  private readonly conversationOverrides = new Map<string, boolean>();

  constructor(private readonly options: PluginModuleLoaderOptions) {}

  hasLoadedDigest = (digest: string): boolean => this.loaded.has(digest);

  private activeFor(pluginId: string, record: PluginStateRecord, agentId: string): boolean {
    return this.conversationOverrides.get(pluginId) ?? enabledInState(record, agentId);
  }

  private activeAnywhere(pluginId: string, record: PluginStateRecord): boolean {
    return (
      this.conversationOverrides.get(pluginId) ??
      (record.enabledForAllAgents || record.enabledAgentIds.length > 0)
    );
  }

  listConversationOverrides(): ReadonlyMap<string, boolean> {
    return new Map(this.conversationOverrides);
  }

  /**
   * Turn a plugin on or off for the open conversation. Turning one on demands the same trusted
   * digest and capability consent a saved enable does, and refuses a hook another plugin active
   * for `agentId` already handles.
   */
  async setConversationOverride(
    pluginId: string,
    enabled: boolean,
    agentId: string,
  ): Promise<void> {
    const state = await this.options.stateStore.read();
    const record = state.plugins[pluginId];
    if (record === undefined) {
      throw new Error(`Plugin ${pluginId} is not installed`);
    }
    if (enabled) {
      assertAuthorized(pluginId, record);
      const conflicts = hookConflicts(
        record.current.manifest,
        Object.entries(state.plugins)
          .filter(
            ([otherId, other]) => otherId !== pluginId && this.activeFor(otherId, other, agentId),
          )
          .map(([, other]) => other.current.manifest),
      );
      if (conflicts.length > 0) {
        throw new Error(`Plugin hook conflict for this conversation: ${conflicts.join("; ")}`);
      }
    }
    this.conversationOverrides.set(pluginId, enabled);
  }

  clearConversationOverride(pluginId: string): void {
    this.conversationOverrides.delete(pluginId);
  }

  clearConversationOverrides(): void {
    this.conversationOverrides.clear();
  }

  /**
   * Confirm the installed code still hashes to its trusted digest, sits at its digest-addressed
   * path, and imports nothing outside the digest-addressed directory.
   */
  private async verifyDigestAddressed(pluginId: string, record: PluginLockRecord): Promise<void> {
    const digest = record.manifest.sha256;
    if (record.kind === "source") {
      try {
        await verifySourceInstall({
          sourceRoot: this.options.installer.sourcePath(digest),
          entry: record.manifest.artifact,
          digest,
          artifactPath: record.artifactPath,
        });
      } catch (error) {
        throw new Error(`Plugin ${pluginId} failed verification: ${toError(error).message}`, {
          cause: error,
        });
      }
      return;
    }
    if (record.artifactPath !== this.options.installer.artifactPath(digest)) {
      throw new Error(`Plugin ${pluginId} artifact path is not digest-addressed`);
    }
    try {
      await this.options.installer.assertIntact(digest);
    } catch (error) {
      throw new Error(`Plugin ${pluginId} failed verification: ${toError(error).message}`, {
        cause: error,
      });
    }
  }

  /** Return the current enablement snapshot without importing plugin code. */
  async listEnabledForAgent(agentId: string): Promise<readonly EnabledPluginSnapshot[]> {
    if (agentId.trim().length === 0) throw new Error("agentId cannot be empty");
    const state = await this.options.stateStore.read();
    return Object.entries(state.plugins)
      .filter(([id, record]) => this.activeFor(id, record, agentId))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, record]) => ({ id, digest: record.current.manifest.sha256 }));
  }

  /**
   * Manifests of every plugin enabled for at least one agent or for the open conversation, without
   * importing any code. For
   * reading declared, inert data (personas, skills) that needs no module execution — plugins are
   * treated as globally available once enabled anywhere.
   */
  async listEnabledManifests(): Promise<readonly PluginManifest[]> {
    const state = await this.options.stateStore.read();
    return Object.entries(state.plugins)
      .filter(([id, record]) => this.activeAnywhere(id, record))
      .map(([, record]) => record.current.manifest)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  /** Verify and import all plugins enabled for one agent without registering them. */
  async loadEnabledForAgent(agentId: string): Promise<readonly LoadedPlugin[]> {
    if (agentId.trim().length === 0) {
      throw new Error("agentId cannot be empty");
    }
    const state = await this.options.stateStore.read();
    const enabled = Object.entries(state.plugins)
      .filter(([id, record]) => this.activeFor(id, record, agentId))
      .sort(([left], [right]) => left.localeCompare(right));

    // Validate every grant before importing any code. This avoids partial loading
    // if one enabled record was modified or its grants became stale.
    for (const [pluginId, record] of enabled) assertAuthorized(pluginId, record);

    const verified = await Promise.all(
      enabled.map(async ([pluginId, record]) => {
        await this.verifyDigestAddressed(pluginId, record.current);
        return [pluginId, record] as const;
      }),
    );

    const loaded: LoadedPlugin[] = [];
    for (const [pluginId, record] of verified) {
      const { manifest } = record.current;
      const namespace = (await import(pathToFileURL(record.current.artifactPath).href)) as {
        readonly default?: unknown;
      };
      if (!isPluginModule(namespace.default)) {
        throw new Error(`Plugin ${pluginId} does not export the Jazz plugin API v1 module shape`);
      }
      if (namespace.default.apiVersion !== manifest.hostApi) {
        throw new Error(`Plugin ${pluginId} module API does not match its manifest`);
      }
      this.loaded.add(manifest.sha256);
      loaded.push({ manifest, module: namespace.default });
    }
    return loaded;
  }
}
