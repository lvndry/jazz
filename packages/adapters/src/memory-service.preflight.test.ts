/** Exercises the proposed capture-to-use path against real scoped files and a scripted model. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { createAgentRunMetrics } from "@jazz/core/agent/metrics/agent-run-metrics";
import type { LLMService } from "@jazz/core/interfaces/llm";
import type { LoggerService } from "@jazz/core/interfaces/logger";
import { runMemoryPreflight } from "@jazz/core/memory/preflight";
import type { Agent } from "@jazz/core/types";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { MemoryServiceImpl } from "./memory-service";

const agent: Agent = {
  id: "test-agent",
  name: "Test",
  config: {
    persona: "default",
    llmProvider: "openrouter",
    llmModel: "test-model",
    memoryScopes: ["personal"],
    experimentalMemoryPreflight: true,
  },
  createdAt: new Date(),
  updatedAt: new Date(),
};

const logger = { warn: () => Effect.void } as unknown as LoggerService;
const memoryPath = "personal/when/food/favorite-fruit.md";

describe("personal memory preflight", () => {
  test("creates the first memory before the memory directory exists", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-memory-first-write-"));
    try {
      const memory = new MemoryServiceImpl({ baseMemoryDirectory: path.join(directory, "memory") });
      const result = await Effect.runPromise(
        memory
          .create(["personal"], memoryPath, 'The user said: "My favorite fruit is banana."\n', {
            agentId: "test-agent",
            entry: { origin: "user" },
          })
          .pipe(Effect.provide(NodeFileSystem.layer)),
      );
      expect(result.success).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("captures banana, recalls it for shopping, amends and forgets it, and rejects injection", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-memory-preflight-"));
    try {
      const memory = new MemoryServiceImpl({ baseMemoryDirectory: directory });
      const decisions = [
        {
          mutation: {
            kind: "capture",
            sourceQuote: "My favorite fruit is banana.",
            subject: "favorite fruit",
            topic: "food",
          },
          recallPaths: [],
        },
        { mutation: { kind: "none" }, recallPaths: [] },
        { mutation: { kind: "none" }, recallPaths: [memoryPath] },
        {
          mutation: {
            kind: "capture",
            sourceQuote: "My favorite fruit is pineapple.",
            subject: "favorite fruit",
            topic: "food",
          },
          recallPaths: [],
        },
        {
          mutation: {
            kind: "amend",
            sourceQuote: "Actually, my favorite fruit is mango.",
            targetPath: memoryPath,
          },
          recallPaths: [],
        },
        {
          mutation: {
            kind: "forget",
            sourceQuote: "Forget my favorite fruit.",
            targetPath: memoryPath,
          },
          recallPaths: [],
        },
      ];
      const offered: unknown[] = [];
      const llm = {
        createChatCompletion: (
          _provider: unknown,
          options: { messages: { content: string }[] },
        ) => {
          offered.push(JSON.parse(options.messages[1]!.content));
          const decision = decisions.shift();
          if (decision === undefined) throw new Error("unexpected preflight call");
          return Effect.succeed({
            id: "decision",
            model: "test-model",
            content: "",
            toolCalls: [
              {
                id: "decision-tool",
                type: "function",
                function: { name: "personal_memory_decision", arguments: JSON.stringify(decision) },
              },
            ],
            usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
          });
        },
      } as unknown as LLMService;

      async function turn(userInput: string, index: number) {
        const metrics = createAgentRunMetrics({ agent, conversationId: `conversation-${index}` });
        const result = await Effect.runPromise(
          runMemoryPreflight(
            {
              agent,
              userInput,
              sourceRef: `user:${index}`,
              scopes: ["personal"],
              allowWrites: true,
              metrics,
            },
            { llm, memory, logger },
          ).pipe(Effect.provide(NodeFileSystem.layer)),
        );
        expect(metrics.totalPromptTokens).toBe(20);
        expect(metrics.totalCompletionTokens).toBe(10);
        return result;
      }

      expect((await turn("My favorite fruit is banana.", 1)).mutation).toBe("captured");
      expect(fs.readFileSync(path.join(directory, memoryPath), "utf8")).toContain("banana");

      expect((await turn("Explain TypeScript generics.", 2)).selected).toEqual([]);
      const shopping = await turn("Make me a shopping list.", 3);
      expect(shopping.selected).toEqual([
        { scope: "personal", summary: 'The user said: "My favorite fruit is banana."' },
      ]);
      expect(offered[2]).toMatchObject({ candidates: [{ path: memoryPath }] });

      expect((await turn("Make me a shopping list.", 4)).mutation).toBe("rejected");
      expect(fs.readFileSync(path.join(directory, memoryPath), "utf8")).toContain("banana");

      expect((await turn("Actually, my favorite fruit is mango.", 5)).mutation).toBe("amended");
      expect(fs.readFileSync(path.join(directory, memoryPath), "utf8")).toContain("mango");
      expect(fs.readFileSync(path.join(directory, memoryPath), "utf8")).not.toContain("banana");

      expect((await turn("Forget my favorite fruit.", 6)).mutation).toBe("forgotten");
      expect(fs.existsSync(path.join(directory, memoryPath))).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
