/**
 * Runtime bridge from durable adapter state to core's per-run plugin host.
 *
 * Enabled records are re-read and digest-verified for every run. Imports occur
 * only after trust and consent checks, while core exclusively owns registration,
 * hook deadlines, budget accounting, secret disclosure, and session cleanup.
 */

import { createAgentRunMetrics } from "@jazz/core/agent/metrics/agent-run-metrics";
import { createPluginSession } from "@jazz/core/agent/plugins/plugin-session";
import {
  PluginRuntimeServiceTag,
  type PluginRuntimeService,
  type PluginSession,
  type PluginSessionOptions,
} from "@jazz/core/interfaces/plugin-runtime";
import {
  PluginRuntimeError,
  type PluginCommandInfo,
  type PluginCommandResult,
  type PluginPersonaInfo,
  type PluginSkillInfo,
  type PluginToolInfo,
  type PluginToolResult,
} from "@jazz/core/types/plugin";
import { Effect, Layer } from "effect";
import type { PluginModuleLoader } from "./module-loader";
import type { PluginSecretStore } from "./secret-store";

/**
 * A throwaway metrics object for a tool-only session. Plugin tools do not touch the decision-cost
 * accounting these carry; the session type requires them, so we give it inert ones.
 */
function toolSessionMetrics(agentId: string): PluginSessionOptions["metrics"] {
  const now = new Date();
  return createAgentRunMetrics({
    agent: {
      id: agentId,
      name: agentId,
      config: { persona: "default", llmProvider: "openai", llmModel: "plugin-tools" },
      createdAt: now,
      updatedAt: now,
    },
    conversationId: `plugin-tools:${agentId}`,
  });
}

export interface PluginRuntimeServiceOptions {
  readonly loader: PluginModuleLoader;
  readonly secrets: PluginSecretStore;
  readonly reportFailure?: (pluginId: string, message: string) => void;
}

export class PluginRuntimeServiceImpl implements PluginRuntimeService {
  constructor(private readonly options: PluginRuntimeServiceOptions) {}

  openSession(run: PluginSessionOptions) {
    return Effect.tryPromise({
      try: () => this.options.loader.loadEnabledForAgent(run.agentId),
      catch: (cause) =>
        new PluginRuntimeError({
          message: `failed to load enabled plugins for agent ${run.agentId}`,
          cause,
        }),
    }).pipe(
      Effect.flatMap((plugins) =>
        createPluginSession({
          ...run,
          plugins,
          resolveSecret: (pluginId, declaration) => this.options.secrets.get(pluginId, declaration),
          ...(this.options.reportFailure === undefined
            ? {}
            : { reportFailure: this.options.reportFailure }),
        }),
      ),
    );
  }

  listAgentTools(agentId: string): Effect.Effect<readonly PluginToolInfo[]> {
    return Effect.acquireUseRelease(
      this.openSession({ agentId, metrics: toolSessionMetrics(agentId) }),
      (session: PluginSession) => Effect.sync(() => session.listTools()),
      (session: PluginSession) => session.close(),
    ).pipe(Effect.catchAll(() => Effect.succeed([] as readonly PluginToolInfo[])));
  }

  runAgentTool(
    agentId: string,
    name: string,
    args: Record<string, unknown>,
  ): Effect.Effect<PluginToolResult> {
    return Effect.acquireUseRelease(
      this.openSession({ agentId, metrics: toolSessionMetrics(agentId) }),
      (session: PluginSession) => session.runTool(name, args),
      (session: PluginSession) => session.close(),
    ).pipe(
      Effect.catchAll(() =>
        Effect.succeed<PluginToolResult>({
          content: `plugin tool ${name} is unavailable`,
          isError: true,
        }),
      ),
    );
  }

  listAgentCommands(agentId: string): Effect.Effect<readonly PluginCommandInfo[]> {
    return Effect.acquireUseRelease(
      this.openSession({ agentId, metrics: toolSessionMetrics(agentId) }),
      (session: PluginSession) => Effect.sync(() => session.listCommands()),
      (session: PluginSession) => session.close(),
    ).pipe(Effect.catchAll(() => Effect.succeed([] as readonly PluginCommandInfo[])));
  }

  runAgentCommand(
    agentId: string,
    name: string,
    args: readonly string[],
  ): Effect.Effect<PluginCommandResult> {
    return Effect.acquireUseRelease(
      this.openSession({ agentId, metrics: toolSessionMetrics(agentId) }),
      (session: PluginSession) => session.runCommand(name, args),
      (session: PluginSession) => session.close(),
    ).pipe(Effect.catchAll(() => Effect.succeed<PluginCommandResult>({})));
  }

  listAllPersonas(): Effect.Effect<readonly PluginPersonaInfo[]> {
    return Effect.tryPromise(() => this.options.loader.listEnabledManifests()).pipe(
      Effect.map((manifests) =>
        manifests.flatMap((manifest) =>
          manifest.personas.map((persona) => ({ ...persona, pluginId: manifest.id })),
        ),
      ),
      Effect.catchAll(() => Effect.succeed([] as readonly PluginPersonaInfo[])),
    );
  }

  listAllSkills(): Effect.Effect<readonly PluginSkillInfo[]> {
    return Effect.tryPromise(() => this.options.loader.listEnabledManifests()).pipe(
      Effect.map((manifests) =>
        manifests.flatMap((manifest) =>
          manifest.skills.map((skill) => ({ ...skill, pluginId: manifest.id })),
        ),
      ),
      Effect.catchAll(() => Effect.succeed([] as readonly PluginSkillInfo[])),
    );
  }
}

export function createPluginRuntimeServiceLayer(
  options: PluginRuntimeServiceOptions,
): Layer.Layer<PluginRuntimeService> {
  return Layer.succeed(PluginRuntimeServiceTag, new PluginRuntimeServiceImpl(options));
}
