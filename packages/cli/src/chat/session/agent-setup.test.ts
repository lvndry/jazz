/**
 * Exercises chat setup with the production tool registry before any model turn.
 * Configured peers must already be discoverable by /tools at that point.
 */
import { silentLogger } from "@jazz/core/agent/test-logger";
import { createToolRegistryLayer } from "@jazz/core/agent/tools/tool-registry";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { MCPServerManagerTag } from "@jazz/core/interfaces/mcp-server";
import { PresentationServiceTag } from "@jazz/core/interfaces/presentation";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import { ToolRegistryTag } from "@jazz/core/interfaces/tool-registry";
import type { Agent, AppConfig } from "@jazz/core/types";
import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { setupAgent } from "./agent-setup";

const agent: Agent = {
  id: "chat-test",
  name: "chatgpt-sol",
  config: {
    persona: "default",
    llm: { provider: "chatgpt", model: "gpt-6-sol" },
    tools: ["ask_peer", "request_clarification"],
  },
  createdAt: new Date(),
  updatedAt: new Date(),
};

test.each([true, false])(
  "registers peer tools before the first turn when peers exist: %s",
  async (hasPeers) => {
    const config: AppConfig = {
      storage: { type: "file", path: "/unused" },
      logging: { level: "info", format: "plain" },
      peers: hasPeers ? [{ name: "server", url: "http://127.0.0.1:4747/peer/ask" }] : [],
    };
    const categories = await Effect.runPromise(
      Effect.gen(function* () {
        yield* setupAgent(agent, "conversation-test");
        const registry = yield* ToolRegistryTag;
        return yield* registry.listToolsByCategory();
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            createToolRegistryLayer(),
            Layer.mock(AgentConfigServiceTag, {
              appConfig: Effect.succeed(config),
              secretStorageUnavailable: () => false,
            }),
            Layer.succeed(LoggerServiceTag, silentLogger),
            Layer.mock(MCPServerManagerTag, {}),
            Layer.mock(PresentationServiceTag, {
              canPromptForApproval: () => false,
              formatToolArguments: () => "",
              formatToolResult: (_name, result) => result,
            }),
            Layer.mock(TerminalServiceTag, { isInteractive: false }),
          ),
        ),
      ),
    );
    if (hasPeers) expect(categories["Peers"]).toEqual(["ask_peer", "request_clarification"]);
    else expect(categories["Peers"]).toBeUndefined();
  },
);
