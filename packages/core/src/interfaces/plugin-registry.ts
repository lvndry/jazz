/** Jazz-owned persistence boundary for plugin installation, trust, consent, and agent enablement. */

import { Context, type Effect } from "effect";
import type { PluginConsentGrant, PluginManifest, PluginRegistryError } from "@/core/types/plugin";

export interface InstalledPluginRecord {
  readonly manifest: PluginManifest;
  readonly artifactPath: string;
  readonly sourceUrl: string;
  readonly trusted: boolean;
  readonly consent?: PluginConsentGrant;
  readonly enabledAgentIds: readonly string[];
}

export interface PluginRegistryService {
  readonly list: () => Effect.Effect<readonly InstalledPluginRecord[], PluginRegistryError>;
  readonly get: (
    pluginId: string,
  ) => Effect.Effect<InstalledPluginRecord | undefined, PluginRegistryError>;
  readonly putInstalled: (
    record: InstalledPluginRecord,
  ) => Effect.Effect<void, PluginRegistryError>;
  readonly remove: (pluginId: string) => Effect.Effect<void, PluginRegistryError>;
  readonly setTrusted: (
    pluginId: string,
    trusted: boolean,
  ) => Effect.Effect<void, PluginRegistryError>;
  readonly setConsent: (
    pluginId: string,
    consent: PluginConsentGrant | undefined,
  ) => Effect.Effect<void, PluginRegistryError>;
  readonly setAgentEnabled: (
    pluginId: string,
    agentId: string,
    enabled: boolean,
  ) => Effect.Effect<void, PluginRegistryError>;
  readonly listEnabledForAgent: (
    agentId: string,
  ) => Effect.Effect<readonly InstalledPluginRecord[], PluginRegistryError>;
}

export const PluginRegistryServiceTag = Context.GenericTag<PluginRegistryService>(
  "@jazz/core/PluginRegistryService",
);
