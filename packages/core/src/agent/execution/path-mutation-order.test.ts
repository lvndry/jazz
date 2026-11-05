import { describe, expect, it } from "bun:test";
import { Effect, FileSystem, Layer } from "effect";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import { PresentationServiceTag, type PresentationService } from "@/core/interfaces/presentation";
import { ToolRegistryTag, type ToolRegistry } from "@/core/interfaces/tool-registry";
import { partialFake, withoutServices } from "@/core/test-support/fakes";
import type { ToolCall } from "@/core/types/tools";
import { earlierCallsOnSamePaths, resolveMutatedPaths } from "./path-mutation-order";
import { ToolBatchLedger } from "./tool-batch-ledger";
import { ToolExecutor } from "./tool-executor";
import { createAgentRunMetrics } from "../metrics/agent-run-metrics";
import { silentLogger } from "../test-logger";

describe("resolveMutatedPaths", () => {
  const context = { agentId: "agent-1", conversationId: "c" };
  const fileSystemContext = partialFake<FileSystemContextService>({
    getCwd: () => Effect.succeed("/work"),
    resolvePath: (_key: unknown, rawPath: string) =>
      Effect.succeed(rawPath.startsWith("/") ? rawPath : `/work/${rawPath}`),
  });

  const resolve = (toolName: string, args: Record<string, unknown>) =>
    Effect.runPromise(
      resolveMutatedPaths(toolName, args, context, fileSystemContext).pipe(
        Effect.provide(Layer.succeed(FileSystem.FileSystem, {} as FileSystem.FileSystem)),
      ),
    );

  it("names the paths a filesystem mutation targets", async () => {
    expect(await resolve("write_file", { path: "a.txt", content: "x" })).toEqual(["/work/a.txt"]);
    expect(await resolve("mv", { source: "/a", destination: "/b" })).toEqual(["/a", "/b"]);
  });

  it("names the PDF and its sibling HTML source for create_pdf, explicit or derived", async () => {
    expect(await resolve("create_pdf", { title: "Q3 Report!", html: "<p/>" })).toEqual([
      "/work/q3-report.pdf",
      "/work/q3-report.pdf.source.html",
    ]);
    expect(await resolve("create_pdf", { title: "t", path: "out/r.pdf", html: "<p/>" })).toEqual([
      "/work/out/r.pdf",
      "/work/out/r.pdf.source.html",
    ]);
  });

  it("keeps scratchpad paths apart from filesystem paths", async () => {
    const [scratchpadPath] = await resolve("manage_scratchpad", { command: "create", path: "a" });
    expect(scratchpadPath).not.toBe("/work/a");
    expect(
      await resolve("manage_scratchpad", { command: "rename", old_path: "a", new_path: "b" }),
    ).toHaveLength(2);
  });

  it("names nothing for reads and shell commands", async () => {
    expect(await resolve("read_file", { path: "/a" })).toEqual([]);
    expect(await resolve("execute_command", { command: "rm /a" })).toEqual([]);
  });
});

describe("earlierCallsOnSamePaths", () => {
  it("points each call at the earlier calls it is not already ordered after", () => {
    expect(earlierCallsOnSamePaths([["/w/a"], ["/w/b"], ["/w/a"], ["/w"], []])).toEqual([
      [],
      [],
      [0],
      [1, 2],
      [],
    ]);
  });

  it("does not treat a sibling with a shared name prefix as overlapping", () => {
    expect(earlierCallsOnSamePaths([["/w/app"], ["/w/application"]])).toEqual([[], []]);
  });

  it("orders a removal of a directory after a write beneath a child named like a parent step", () => {
    expect(earlierCallsOnSamePaths([["/work/..cache/file"], ["/work"]])).toEqual([[], [0]]);
  });

  it("orders a write after the removal of its ancestor", () => {
    expect(earlierCallsOnSamePaths([["/w"], ["/w/a/b"]])).toEqual([[], [0]]);
  });

  it("chains a large same-path batch in linear time", () => {
    const callCount = 2000;
    const started = performance.now();
    const waitsFor = earlierCallsOnSamePaths(
      Array.from({ length: callCount }, () => ["/work/a.txt"]),
    );
    const elapsedMs = performance.now() - started;

    expect(waitsFor[0]).toEqual([]);
    expect(waitsFor.slice(1).every((earlier, index) => earlier.join() === String(index))).toBe(
      true,
    );
    expect(elapsedMs).toBeLessThan(500);
  });
});

describe("ToolExecutor.executeToolCalls path ordering", () => {
  const pathResolver = partialFake<FileSystemContextService>({
    resolvePath: (_key: unknown, rawPath: string) => Effect.succeed(rawPath),
  });

  function pathCall(id: string, name: string, args: Record<string, string>): ToolCall {
    return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
  }

  function runBatch(toolCalls: ToolCall[], ledger?: ToolBatchLedger, sleepMillis = 30) {
    const events: string[] = [];
    const registry = partialFake<ToolRegistry>({
      getTool: (name: string) => Effect.succeed({ name, timeoutMs: 5000 }),
      executeTool: (name: string, args: Record<string, string>) =>
        Effect.gen(function* () {
          const label = `${name}:${args["path"]}`;
          events.push(`start ${label}`);
          yield* Effect.sleep(`${sleepMillis} millis`);
          events.push(`end ${label}`);
          return { success: true, result: label };
        }),
    });
    const presentation = partialFake<PresentationService>({
      formatToolsDetected: () => Effect.succeed(""),
      writeOutput: () => Effect.void,
      writeBlankLine: () => Effect.void,
      formatToolExecutionStart: () => Effect.succeed(""),
      formatToolExecutionComplete: () => Effect.succeed(""),
      formatToolResult: () => "",
      formatToolExecutionError: () => Effect.succeed(""),
      signalToolExecutionStarted: () => Effect.void,
    });
    const layer = Layer.mergeAll(
      Layer.succeed(ToolRegistryTag, registry),
      Layer.succeed(PresentationServiceTag, presentation),
      Layer.succeed(LoggerServiceTag, silentLogger),
      Layer.succeed(
        AgentConfigServiceTag,
        partialFake<AgentConfigService>({
          appConfig: Effect.succeed({}),
        }),
      ),
      Layer.succeed(FileSystem.FileSystem, {} as FileSystem.FileSystem),
      Layer.succeed(FileSystemContextServiceTag, pathResolver),
    );
    const outcomes = Effect.runPromise(
      withoutServices(
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
        ).pipe(Effect.provide(layer)),
      ),
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

  it("executes a 2000-call same-path batch strictly in order", async () => {
    const calls = Array.from({ length: 2000 }, (_unused, index) =>
      pathCall(`call-${index}`, "write_file", { path: "/work/a.txt" }),
    );
    const { events, outcomes } = runBatch(calls, undefined, 0);
    const results = await outcomes;

    expect(
      events.every((event, index) => event.startsWith(index % 2 === 0 ? "start" : "end")),
    ).toBe(true);
    expect(results.map((result) => result.toolCallId)).toEqual(calls.map((call) => call.id));
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

  it("orders create_pdf with a write to its default output", async () => {
    const { events, outcomes } = runBatch([
      pathCall("pdf", "create_pdf", { title: "Report", html: "<p/>", path: "/work/r.pdf" }),
      pathCall("html", "write_file", { path: "/work/r.pdf.source.html" }),
    ]);
    await outcomes;

    expect(events.indexOf("start write_file:/work/r.pdf.source.html")).toBeGreaterThan(
      events.indexOf("end create_pdf:undefined"),
    );
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
