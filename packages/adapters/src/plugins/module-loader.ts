/**
 * Consent-gated verification and import of plugin modules.
 *
 * This boundary deliberately does not register plugins or construct a host API.
 * Core owns registration and per-run isolation; the adapter only turns enabled,
 * digest-verified artifacts into the `LoadedPlugin` values core accepts.
 */

import { pathToFileURL } from "node:url";
import type { JazzPluginModule, LoadedPlugin, PluginManifest } from "@jazz/core/types/plugin";
import type { PluginArtifactInstaller } from "./artifact-installer";
import { pluginConsentDigest } from "./plugin-registry-service";
import type { PluginStateRecord, PluginStateStore } from "./state-store";

export interface PluginModuleLoaderOptions {
  readonly stateStore: PluginStateStore;
  readonly installer: PluginArtifactInstaller;
}

export interface EnabledPluginSnapshot {
  readonly id: string;
  readonly digest: string;
}

function isPluginModule(value: unknown): value is JazzPluginModule {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
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

export class PluginModuleLoader {
  private readonly loaded = new Set<string>();

  constructor(private readonly options: PluginModuleLoaderOptions) {}

  hasLoadedDigest = (digest: string): boolean => this.loaded.has(digest);

  /** Return the current enablement snapshot without importing plugin code. */
  async listEnabledForAgent(agentId: string): Promise<readonly EnabledPluginSnapshot[]> {
    if (agentId.trim().length === 0) throw new Error("agentId cannot be empty");
    const state = await this.options.stateStore.read();
    return Object.entries(state.plugins)
      .filter(
        ([, record]) => record.enabledForAllAgents || record.enabledAgentIds.includes(agentId),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, record]) => ({ id, digest: record.current.manifest.sha256 }));
  }

  /**
   * Manifests of every plugin enabled for at least one agent, without importing any code. For
   * reading declared, inert data (personas, skills) that needs no module execution — plugins are
   * treated as globally available once enabled anywhere.
   */
  async listEnabledManifests(): Promise<readonly PluginManifest[]> {
    const state = await this.options.stateStore.read();
    return Object.values(state.plugins)
      .filter((record) => record.enabledForAllAgents || record.enabledAgentIds.length > 0)
      .map((record) => record.current.manifest)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  /** Verify and import all plugins enabled for one agent without registering them. */
  async loadEnabledForAgent(agentId: string): Promise<readonly LoadedPlugin[]> {
    if (agentId.trim().length === 0) throw new Error("agentId cannot be empty");
    const state = await this.options.stateStore.read();
    const enabled = Object.entries(state.plugins)
      .filter(
        ([, record]) => record.enabledForAllAgents || record.enabledAgentIds.includes(agentId),
      )
      .sort(([left], [right]) => left.localeCompare(right));

    // Validate every grant before importing any code. This avoids partial loading
    // if one enabled record was modified or its grants became stale.
    for (const [pluginId, record] of enabled) assertAuthorized(pluginId, record);

    const verified = await Promise.all(
      enabled.map(async ([pluginId, record]) => {
        const expectedPath = this.options.installer.artifactPath(record.current.manifest.sha256);
        if (record.current.artifactPath !== expectedPath) {
          throw new Error(`Plugin ${pluginId} artifact path is not digest-addressed`);
        }
        const valid = await this.options.installer.verify(record.current.manifest.sha256);
        if (!valid) {
          throw new Error(`Plugin ${pluginId} artifact is missing or failed digest verification`);
        }
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
