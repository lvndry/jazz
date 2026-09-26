/** Effect service adapter for core's plugin registry persistence port. */

import {
  PluginRegistryServiceTag,
  type InstalledPluginRecord,
  type PluginRegistryService,
} from "@jazz/core/interfaces/plugin-registry";
import { PluginRegistryError } from "@jazz/core/types/plugin";
import { toError } from "@jazz/core/utils/errors";
import { Effect, Layer } from "effect";
import { parsePluginManifest } from "./manifest-schema";
import { PluginRegistryServiceImpl, pluginConsentDigest } from "./plugin-registry-service";
import type { PluginStateDocument, PluginStateRecord } from "./state-store";

function replace(
  state: PluginStateDocument,
  id: string,
  value: PluginStateRecord | undefined,
): PluginStateDocument {
  const plugins = { ...state.plugins };
  if (value === undefined) delete plugins[id];
  else plugins[id] = value;
  return { ...state, plugins };
}

function toInstalled(record: PluginStateRecord): InstalledPluginRecord {
  const digest = record.current.manifest.sha256;
  const consentDigest = pluginConsentDigest(record.current.manifest);
  const consent = record.consentGrants.find((grant) => grant.digest === consentDigest);
  return {
    manifest: record.current.manifest,
    artifactPath: record.current.artifactPath,
    sourceUrl: record.current.source,
    trusted: record.trustedDigests.includes(digest),
    ...(consent === undefined ? {} : { consent }),
    enabledAgentIds: record.enabledAgentIds,
    enabledForAllAgents: record.enabledForAllAgents,
  };
}

function failure(operation: string, cause: unknown): PluginRegistryError {
  return new PluginRegistryError({
    operation,
    message: toError(cause).message,
    cause,
  });
}

function attempt<T>(
  operation: string,
  work: () => Promise<T>,
): Effect.Effect<T, PluginRegistryError> {
  return Effect.tryPromise({ try: work, catch: (cause) => failure(operation, cause) });
}

export class CorePluginRegistryServiceImpl implements PluginRegistryService {
  constructor(readonly lifecycle: PluginRegistryServiceImpl) {}

  list = () =>
    attempt("list", async () => {
      const state = await this.lifecycle.stateStore.read();
      return Object.entries(state.plugins)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, record]) => toInstalled(record));
    });

  get = (pluginId: string) =>
    attempt("get", async () => {
      const record = (await this.lifecycle.stateStore.read()).plugins[pluginId];
      return record === undefined ? undefined : toInstalled(record);
    });

  putInstalled = (record: InstalledPluginRecord) =>
    attempt("putInstalled", async () => {
      const manifest = parsePluginManifest(record.manifest);
      const expectedPath = this.lifecycle.installer.artifactPath(manifest.sha256);
      if (record.artifactPath !== expectedPath) {
        throw new Error("installed artifact path is not the digest-addressed adapter path");
      }
      if (!(await this.lifecycle.installer.verify(manifest.sha256))) {
        throw new Error("installed artifact is missing or failed digest verification");
      }
      if (record.consent && record.consent.digest !== pluginConsentDigest(manifest)) {
        throw new Error("consent grant does not match the installed manifest");
      }
      await this.lifecycle.stateStore.transact((state) => {
        const existing = state.plugins[manifest.id];
        const next: PluginStateRecord = {
          current: {
            manifest,
            source: record.sourceUrl,
            artifactPath: record.artifactPath,
            installedAt: new Date().toISOString(),
          },
          ...(existing === undefined ? {} : { previous: existing.current }),
          trustedDigests: record.trusted ? [manifest.sha256] : [],
          consentGrants: record.consent ? [record.consent] : [],
          // A persisted caller cannot bypass enable-time grant/conflict checks.
          enabledAgentIds: [],
          enabledForAllAgents: false,
          activatedDigests: existing?.activatedDigests ?? [],
          storedSecretNames: existing?.storedSecretNames ?? [],
        };
        return { state: replace(state, manifest.id, next), result: undefined };
      });
    });

  remove = (pluginId: string) =>
    attempt("remove", async () => {
      await this.lifecycle.remove(pluginId);
    });

  setTrusted = (pluginId: string, trusted: boolean) =>
    attempt("setTrusted", async () => {
      if (trusted) {
        const digest = (await this.lifecycle.inspect(pluginId)).current.manifest.sha256;
        await this.lifecycle.trust(pluginId, digest);
        return;
      }
      await this.lifecycle.stateStore.transact((state) => {
        const current = state.plugins[pluginId];
        if (!current) throw new Error(`Plugin is not installed: ${pluginId}`);
        const digest = current.current.manifest.sha256;
        return {
          state: replace(state, pluginId, {
            ...current,
            trustedDigests: current.trustedDigests.filter((item) => item !== digest),
            enabledAgentIds: [],
            enabledForAllAgents: false,
          }),
          result: undefined,
        };
      });
    });

  setConsent = (pluginId: string, consent: InstalledPluginRecord["consent"]) =>
    attempt("setConsent", async () => {
      const inspection = await this.lifecycle.inspect(pluginId);
      if (consent !== undefined) {
        await this.lifecycle.grantConsent(pluginId, consent.digest);
        return;
      }
      await this.lifecycle.stateStore.transact((state) => {
        const current = state.plugins[pluginId];
        if (!current) throw new Error(`Plugin is not installed: ${pluginId}`);
        return {
          state: replace(state, pluginId, {
            ...current,
            consentGrants: current.consentGrants.filter(
              (grant) => grant.digest !== inspection.consentDigest,
            ),
            enabledAgentIds: [],
            enabledForAllAgents: false,
          }),
          result: undefined,
        };
      });
    });

  setAgentEnabled = (pluginId: string, agentId: string, enabled: boolean) =>
    attempt("setAgentEnabled", async () => {
      if (enabled) await this.lifecycle.enable(pluginId, agentId);
      else await this.lifecycle.disable(pluginId, agentId);
    });

  listEnabledForAgent = (agentId: string) =>
    attempt("listEnabledForAgent", async () => {
      const state = await this.lifecycle.stateStore.read();
      return Object.entries(state.plugins)
        .filter(
          ([, record]) => record.enabledForAllAgents || record.enabledAgentIds.includes(agentId),
        )
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, record]) => toInstalled(record));
    });
}

export function createPluginRegistryServiceLayer(
  lifecycle: PluginRegistryServiceImpl,
): Layer.Layer<PluginRegistryService> {
  return Layer.succeed(PluginRegistryServiceTag, new CorePluginRegistryServiceImpl(lifecycle));
}
