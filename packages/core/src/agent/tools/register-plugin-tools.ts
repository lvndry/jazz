/**
 * Registers the tools an agent's enabled plugins contribute into the tool registry, mirroring the
 * MCP registration path: declarations come from the plugin runtime, are adapted to Jazz tools, and
 * are registered under a per-plugin deferred category. Execution is delegated back to the runtime.
 *
 * Plugin tools are additive and fail-open: if the runtime is absent or listing fails, no tools are
 * registered and the run proceeds unchanged. Returns the model-facing tool names so the caller can
 * add them to the agent's tool set (enabling a plugin is the opt-in; the tools need no separate
 * mention in the agent's config).
 */

import { Effect, Option } from "effect";
import { FileSystemContextServiceTag } from "@/core/interfaces/fs";
import { PluginRuntimeServiceTag } from "@/core/interfaces/plugin-runtime";
import { ToolRegistryTag, type ToolRegistry } from "@/core/interfaces/tool-registry";
import type { PluginToolInfo } from "@/core/types/plugin";
import { adaptPluginToolToJazz } from "./plugin";
import { pluginToolCategory } from "./tool-categories";

/** Tool names registered per plugin, so a later run can retire ones a plugin no longer declares. */
const registeredPlugins = new Map<string, readonly string[]>();

export function registerPluginToolsForAgent(
  agentId: string,
): Effect.Effect<readonly string[], never, ToolRegistry> {
  return Effect.gen(function* () {
    const runtimeOption = yield* Effect.serviceOption(PluginRuntimeServiceTag);
    if (Option.isNone(runtimeOption)) return [];
    const runtime = runtimeOption.value;
    const registry = yield* ToolRegistryTag;

    const infos = yield* runtime.listAgentTools(agentId);
    const byPlugin = new Map<string, PluginToolInfo[]>();
    for (const info of infos) {
      const list = byPlugin.get(info.pluginId) ?? [];
      list.push(info);
      byPlugin.set(info.pluginId, list);
    }

    const modelFacingNames: string[] = [];
    for (const [pluginId, tools] of byPlugin) {
      const registerTool = registry.registerForCategory(pluginToolCategory(pluginId));
      const names: string[] = [];
      for (const info of tools) {
        const cwd = (context: { readonly conversationId?: string }) =>
          Effect.gen(function* () {
            const fsContext = yield* Effect.serviceOption(FileSystemContextServiceTag);
            return Option.isSome(fsContext)
              ? yield* fsContext.value.getCwd({
                  agentId,
                  ...(context.conversationId ? { conversationId: context.conversationId } : {}),
                })
              : process.cwd();
          });
        const jazzTools = adaptPluginToolToJazz(info, {
          run: (name, args, context) =>
            cwd(context).pipe(
              Effect.flatMap((path) => runtime.runAgentTool(agentId, name, args, path)),
            ),
          prepare: (name, args, context) =>
            cwd(context).pipe(
              Effect.flatMap((path) => runtime.prepareAgentTool(agentId, name, args, path)),
            ),
          execute: (name, args, prepared, context) =>
            cwd(context).pipe(
              Effect.flatMap((path) =>
                runtime.executePreparedAgentTool(agentId, name, args, prepared, path),
              ),
            ),
        });
        for (const tool of jazzTools) {
          yield* registerTool(tool);
          names.push(tool.name);
        }
      }

      const previous = registeredPlugins.get(pluginId) ?? [];
      const nextNames = new Set(names);
      for (const staleName of previous) {
        if (!nextNames.has(staleName)) yield* registry.unregisterTool(staleName);
      }
      registeredPlugins.set(pluginId, names);
      // Only the model-facing half of an approval pair is offered; the hidden execute_* twin is
      // pulled in by name expansion at the call site.
      modelFacingNames.push(...names.filter((name) => !name.startsWith("execute_")));
    }
    return modelFacingNames;
  });
}
