import { describe, expect, it } from "bun:test";
import { Effect, FileSystem, Layer } from "effect";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import { PresentationServiceTag, type PresentationService } from "@/core/interfaces/presentation";
import { ToolRegistryTag, type ToolRegistry } from "@/core/interfaces/tool-registry";
import type { ToolCall } from "@/core/types/tools";
import { earlierCallsOnSamePaths, mutatedPathArguments } from "./path-mutation-order";
import { ToolBatchLedger } from "./tool-batch-ledger";
import { ToolExecutor } from "./tool-executor";
import { createAgentRunMetrics } from "../metrics/agent-run-metrics";
import { silentLogger } from "../test-logger";

describe("mutatedPathArguments", () => {
  it("names the paths a filesystem mutation targets", () => {
    expect(mutatedPathArguments("write_file", { path: "/a", content: "x" })).toEqual(["/a"]);
    expect(mutatedPathArguments("mv", { source: "/a", destination: "/b" })).toEqual(["/a", "/b"]);
  });

  it("names nothing for reads and shell commands", () => {
    expect(mutatedPathArguments("read_file", { path: "/a" })).toEqual([]);
    expect(mutatedPathArguments("execute_command", { command: "rm /a" })).toEqual([]);
  });
});

describe("earlierCallsOnSamePaths", () => {
  it("points each call at the earlier calls on an overlapping path", () => {
    expect(earlierCallsOnSamePaths([["/w/a"], ["/w/b"], ["/w/a"], ["/w"], []])).toEqual([
      [],
      [],
      [0],
      [0, 1, 2],
      [],
    ]);
  });

  it("does not treat a sibling with a shared name prefix as overlapping", () => {
    expect(earlierCallsOnSamePaths([["/w/app"], ["/w/application"]])).toEqual([[], []]);
  });
});

describe("ToolExecutor.executeToolCalls path ordering", () => {
  const pathResolver = {
    resolvePath: (_key: unknown, rawPath: string) => Effect.succeed(rawPath),
  } as unknown as FileSystemContextService;

  function pathCall(id: string, name: string, args: Record<string, string>): ToolCall {
    return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
  }

  function runBatch(toolCalls: ToolCall[], ledger?: ToolBatchLedger) {
    const events: string[] = [];
    const registry = {
      getTool: (name: string) => Effect.succeed({ name, timeoutMs: 5000 }),
      executeTool: (name: string, args: Record<string, string>) =>
        Effect.gen(function* () {
          const label = `${name}:${args["path"]}`;
          events.push(`start ${label}`);
          yield* Effect.sleep("30 millis");
          events.push(`end ${label}`);
          return { success: true, result: label };
        }),
    } as unknown as ToolRegistry;
    const presentation = {
      formatToolsDetected: () => Effect.succeed(""),
      writeOutput: () => Effect.void,
      writeBlankLine: () => Effect.void,
      formatToolExecutionStart: () => Effect.succeed(""),
      formatToolExecutionComplete: () => Effect.succeed(""),
      formatToolResult: () => "",
      formatToolExecutionError: () => Effect.succeed(""),
      signalToolExecutionStarted: () => Effect.void,
    } as unknown as PresentationService;
    const layer = Layer.mergeAll(
      Layer.succeed(ToolRegistryTag, registry),
      Layer.succeed(PresentationServiceTag, presentation),
      Layer.succeed(LoggerServiceTag, silentLogger),
      Layer.succeed(AgentConfigServiceTag, {
        appConfig: Effect.succeed({}),
      } as unknown as AgentConfigService),
      Layer.succeed(FileSystem.FileSystem, {} as FileSystem.FileSystem),
      Layer.succeed(FileSystemContextServiceTag, pathResolver),
    );
    const outcomes = Effect.runPromise(
      ToolExecutor.executeToolCalls(
        toolCalls,
        { agentId: "a", conversationId: "c", unrestrictedTools: true },
        { showReasoning: false, showToolExecution: false, mode: "hybrid" },
        null,
        createAgentRunMetrics({
          agent: {
            id: "a",
            name: "a",
            config: { persona: "default", llm: { provider: "openai", model: "m" } },
          },
          conversationId: "c",
          provider: "openai",
          model: "m",
        } as never),
        "a",
        "c",
        "a",
        undefined,
        undefined,
        undefined,
        ledger,
      ).pipe(Effect.provide(layer)) as unknown as Effect.Effect<
        readonly { toolCallId: string }[],
        Error
      >,
    );
    return { events, outcomes };
  }

  it("runs calls that change one path in call order and returns results in call order", async () => {
    const { events, outcomes } = runBatch([
      pathCall("first", "write_file", { path: "/work/a.txt" }),
      pathCall("second", "edit_file", { path: "/work/a.txt" }),
      pathCall("third", "rm", { path: "/work/a.txt" }),
    ]);
    const results = await outcomes;

    expect(events).toEqual([
      "start write_file:/work/a.txt",
      "end write_file:/work/a.txt",
      "start edit_file:/work/a.txt",
      "end edit_file:/work/a.txt",
      "start rm:/work/a.txt",
      "end rm:/work/a.txt",
    ]);
    expect(results.map((result) => result.toolCallId)).toEqual(["first", "second", "third"]);
  });

  it("keeps calls on different paths concurrent", async () => {
    const { events, outcomes } = runBatch([
      pathCall("first", "write_file", { path: "/work/a.txt" }),
      pathCall("second", "write_file", { path: "/work/b.txt" }),
    ]);
    await outcomes;

    expect(events.slice(0, 2).sort()).toEqual([
      "start write_file:/work/a.txt",
      "start write_file:/work/b.txt",
    ]);
  });

  it("orders a removal of a directory after a write inside it", async () => {
    const { events, outcomes } = runBatch([
      pathCall("write", "write_file", { path: "/work/dir/a.txt" }),
      pathCall("remove", "rm", { path: "/work/dir" }),
    ]);
    await outcomes;

    expect(events.indexOf("start rm:/work/dir")).toBeGreaterThan(
      events.indexOf("end write_file:/work/dir/a.txt"),
    );
  });

  it("does not mark a call started while it waits for an earlier call on its path", async () => {
    const toolCalls = [
      pathCall("first", "write_file", { path: "/work/a.txt" }),
      pathCall("second", "write_file", { path: "/work/a.txt" }),
    ];
    const ledger = new ToolBatchLedger(toolCalls);
    const { outcomes } = runBatch(toolCalls, ledger);
    await Effect.runPromise(Effect.sleep("10 millis"));

    expect(ledger.statusOf("first")).toBe("interrupted");
    expect(ledger.statusOf("second")).toBe("not-started");
    await outcomes;
    expect(ledger.statusOf("second")).toBe("completed");
  });
});
