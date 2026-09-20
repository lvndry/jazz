/** Registering enabled-plugin tools into the registry and executing them via the runtime. */

import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import {
  PluginRuntimeServiceTag,
  type PluginRuntimeService,
} from "@/core/interfaces/plugin-runtime";
import { ToolRegistryTag } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext } from "@/core/types";
import type { PluginToolInfo, PluginToolResult } from "@/core/types/plugin";
import { registerPluginToolsForAgent } from "./register-plugin-tools";
import { createToolRegistryLayer } from "./tool-registry";

const toolInfo: PluginToolInfo = {
  pluginId: "com.example.demo",
  name: "reverse_text",
  description: "Reverse text.",
  parameters: { type: "object", properties: { text: { type: "string" } } },
  riskLevel: "read-only",
  egress: false,
};

function fakeRuntime(overrides: Partial<PluginRuntimeService> = {}): PluginRuntimeService {
  return {
    openSession: () => Effect.die("openSession is not used in this test"),
    listAgentTools: () => Effect.succeed<readonly PluginToolInfo[]>([toolInfo]),
    runAgentTool: (_agentId, _name, args) =>
      Effect.succeed<PluginToolResult>({
        content: String(args["text"]).split("").reverse().join(""),
      }),
    listAgentCommands: () => Effect.succeed([]),
    runAgentCommand: () => Effect.succeed({}),
    ...overrides,
  };
}

const context = { agentId: "agent-x" } as ToolExecutionContext;

describe("registerPluginToolsForAgent", () => {
  it("registers an enabled plugin's tool and returns its model-facing name", async () => {
    const layer = Layer.merge(
      createToolRegistryLayer(),
      Layer.succeed(PluginRuntimeServiceTag, fakeRuntime()),
    );
    const names = await Effect.runPromise(
      registerPluginToolsForAgent("agent-x").pipe(Effect.provide(layer)) as Effect.Effect<
        readonly string[],
        never,
        never
      >,
    );
    expect(names).toContain("plugin_com_example_demo_reverse_text");
  });

  it("registers a tool whose execution is delegated to the runtime", async () => {
    const registryLayer = createToolRegistryLayer();
    const layer = Layer.merge(registryLayer, Layer.succeed(PluginRuntimeServiceTag, fakeRuntime()));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* registerPluginToolsForAgent("agent-x");
        const registry = yield* ToolRegistryTag;
        const tool = yield* registry.getTool("plugin_com_example_demo_reverse_text");
        return yield* tool.execute({ text: "abc" }, context);
      }).pipe(Effect.provide(layer)) as Effect.Effect<
        { success: boolean; result: unknown },
        unknown,
        never
      >,
    );
    expect(result).toEqual({ success: true, result: "cba" });
  });

  it("registers nothing when no plugin runtime is available", async () => {
    const names = await Effect.runPromise(
      registerPluginToolsForAgent("agent-x").pipe(
        Effect.provide(createToolRegistryLayer()),
      ) as Effect.Effect<readonly string[], never, never>,
    );
    expect(names).toEqual([]);
  });
});
