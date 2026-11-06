import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { ToolRegistryTag } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext } from "@/core/types";
import { relaxToolArguments, type ArgumentRelaxationReason } from "./argument-tolerance";
import { defineTool, makeZodValidator } from "./base-tool";
import { registerAllTools } from "./register-tools";
import { createToolRegistryLayer } from "./tool-registry";

async function builtInSchemas(): Promise<ReadonlyMap<string, z.ZodType>> {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* registerAllTools();
      const registry = yield* ToolRegistryTag;
      const schemas = new Map<string, z.ZodType>();
      for (const name of yield* registry.listTools()) {
        const tool = yield* registry.getTool(name);
        schemas.set(name, tool.parameters);
      }
      return schemas;
    }).pipe(Effect.provide(createToolRegistryLayer())),
  );
}

const schemas = await builtInSchemas();

function validationOf(toolName: string, args: Record<string, unknown>) {
  const schema = schemas.get(toolName);
  if (schema === undefined) {
    throw new Error(`no built-in tool ${toolName}`);
  }
  const relaxed = relaxToolArguments(toolName, schema, args);
  return {
    relaxed,
    afterRelaxing: makeZodValidator(schema as z.ZodType<Record<string, unknown>>)(relaxed.args),
    asSent: makeZodValidator(schema as z.ZodType<Record<string, unknown>>)(args),
  };
}

const ripgrepBase = { pattern: "needle" };

describe("empty optional values count as omitted", () => {
  const cases: ReadonlyArray<{
    readonly tool: string;
    readonly args: Record<string, unknown>;
    readonly field: string;
    readonly reason: ArgumentRelaxationReason;
  }> = [
    {
      tool: "grep",
      args: { ...ripgrepBase, filePattern: "" },
      field: "filePattern",
      reason: "empty_optional",
    },
    {
      tool: "grep",
      args: { ...ripgrepBase, exclude: "" },
      field: "exclude",
      reason: "empty_optional",
    },
    {
      tool: "grep",
      args: { ...ripgrepBase, outputMode: "" },
      field: "outputMode",
      reason: "empty_optional",
    },
    { tool: "grep", args: { ...ripgrepBase, path: null }, field: "path", reason: "null_optional" },
    { tool: "find", args: { excludePaths: [] }, field: "excludePaths", reason: "empty_optional" },
    { tool: "ls", args: { path: "" }, field: "path", reason: "empty_optional" },
    { tool: "ls", args: { pattern: null }, field: "pattern", reason: "null_optional" },
    {
      tool: "spawn_subagent",
      args: { task: "go", resultSchema: {} },
      field: "resultSchema",
      reason: "empty_optional",
    },
    { tool: "wait_subagents", args: { ids: [] }, field: "ids", reason: "empty_optional" },
  ];

  it.each(cases)("$tool: $field -> $reason", ({ tool, args, field, reason }) => {
    const { relaxed, afterRelaxing } = validationOf(tool, args);
    expect(relaxed.relaxations).toEqual([{ field, reason }]);
    expect(relaxed.args).not.toHaveProperty(field);
    expect(afterRelaxing.valid).toBe(true);
  });

  it("changes nothing when there is nothing to relax", () => {
    const args = { ...ripgrepBase, path: "src" };
    const { relaxed } = validationOf("grep", args);
    expect(relaxed.args).toBe(args);
    expect(relaxed.relaxations).toEqual([]);
  });
});

describe("fields a tool does not use are ignored", () => {
  it("drops an undeclared field that a strict schema would reject", () => {
    const { relaxed, asSent, afterRelaxing } = validationOf("read_file", {
      path: "a.txt",
      startLine: 1,
      note: "why",
    });
    expect(asSent.valid).toBe(false);
    expect(relaxed.relaxations).toEqual([{ field: "note", reason: "unknown_field" }]);
    expect(afterRelaxing).toEqual({ valid: true, value: { path: "a.txt", startLine: 1 } });
  });

  it("drops a sibling command's field on a strict discriminated tool", () => {
    const schema = z.discriminatedUnion("command", [
      z.object({ command: z.literal("create"), body: z.string() }).strict(),
      z.object({ command: z.literal("delete"), path: z.string() }).strict(),
    ]);
    const relaxed = relaxToolArguments("synthetic", schema, {
      command: "delete",
      path: "a",
      body: "unused",
    });
    expect(relaxed.relaxations).toEqual([{ field: "body", reason: "irrelevant_field" }]);
    expect(schema.safeParse(relaxed.args).success).toBe(true);
  });

  it("accepts a sibling command's field on built-in discriminated tools", () => {
    const { afterRelaxing } = validationOf("manage_memory", {
      command: "delete",
      path: "personal/old.md",
      new_path: "personal/new.md",
      source_quote: "The user said: x",
    });
    expect(
      afterRelaxing.valid ||
        afterRelaxing.errors?.every((message) => !message.includes("new_path")),
    ).toBe(true);
  });

  it("leaves a discriminator that selects no command to the schema", () => {
    const { relaxed, afterRelaxing } = validationOf("manage_memory", {
      command: "obliterate",
      stray: "",
    });
    expect(relaxed.relaxations).toEqual([]);
    expect(afterRelaxing.valid).toBe(false);
  });
});

describe("strict fields keep their original error", () => {
  const cases: ReadonlyArray<{ readonly tool: string; readonly args: Record<string, unknown> }> = [
    { tool: "execute_command", args: { command: "ls", description: "list", escalate: "" } },
    { tool: "execute_command", args: { command: "ls", description: "list", workingDirectory: "" } },
    {
      tool: "execute_command",
      args: { command: "ls", description: "list", workingDirectory: null },
    },
    { tool: "edit_file", args: { path: "a.txt", snapshot: "", edits: [] } },
    { tool: "spawn_subagent", args: { task: "go", maxCostUSD: null } },
    { tool: "spawn_subagent", args: { task: "go", maxMinutes: null } },
    { tool: "run_background_jobs", args: { jobs: [], reason: "r", concurrencyCap: null } },
    { tool: "read_pdf", args: { path: "a.pdf", password: "" } },
    { tool: "create_pdf", args: { html: "<p/>", title: "t", path: "" } },
    { tool: "update_work_state", args: { goal: "", constraints: [] } },
    { tool: "rm", args: { path: "a", force: null } },
    { tool: "read_file", args: { path: "a", force: true } },
    { tool: "mv", args: { source: "a", destination: "", force: true } },
  ];

  it.each(cases)("$tool: $args", ({ tool, args }) => {
    const { relaxed, asSent, afterRelaxing } = validationOf(tool, args);
    expect(relaxed.relaxations).toEqual([]);
    expect(afterRelaxing).toEqual(asSent);
  });
});

describe("wrong types and required fields still fail", () => {
  const cases: ReadonlyArray<{ readonly tool: string; readonly args: Record<string, unknown> }> = [
    { tool: "read_file", args: { path: "a", startLine: "" } },
    { tool: "read_file", args: { path: "a", startLine: "3" } },
    { tool: "grep", args: { ...ripgrepBase, maxResults: "" } },
    { tool: "grep", args: { ...ripgrepBase, recursive: "" } },
    { tool: "grep", args: { ...ripgrepBase, outputMode: "everything" } },
    { tool: "find", args: { excludePaths: "" } },
    { tool: "grep", args: { path: "" } },
    { tool: "cd", args: { path: "" } },
    { tool: "write_file", args: { path: "a", content: null } },
  ];

  it.each(cases)("$tool: $args", ({ tool, args }) => {
    const { afterRelaxing, asSent } = validationOf(tool, args);
    expect(afterRelaxing.valid).toBe(false);
    expect(afterRelaxing.errors).toEqual(asSent.errors);
  });
});

describe("defineTool", () => {
  const parameters = z.object({ query: z.string(), filter: z.string().optional() }).strict();

  function recordingLogger(entries: Array<Record<string, unknown> | undefined>): LoggerService {
    const logger = new Proxy({} as LoggerService, {
      get: (_target, property) =>
        property === "debug"
          ? (_message: string, meta?: Record<string, unknown>) =>
              Effect.sync(() => {
                entries.push(meta);
              })
          : () => Effect.void,
    });
    return logger;
  }

  it("hands the handler the relaxed arguments and logs field and reason without values", async () => {
    const received: Array<Record<string, unknown>> = [];
    const tool = defineTool<never, z.infer<typeof parameters>>({
      name: "synthetic_search",
      description: "search",
      disclosure: "private",
      parameters,
      handler: (args) =>
        Effect.sync(() => {
          received.push(args);
          return { success: true, result: null };
        }),
    });
    const entries: Array<Record<string, unknown> | undefined> = [];
    const outcome = await Effect.runPromise(
      tool
        .execute({ query: "secret-looking-value", filter: "", extra: 1 }, {
          agentId: "agent",
        } as ToolExecutionContext)
        .pipe(Effect.provideService(LoggerServiceTag, recordingLogger(entries))),
    );
    expect(outcome.success).toBe(true);
    expect(received).toEqual([{ query: "secret-looking-value" }]);
    expect(entries).toEqual([
      { tool: "synthetic_search", field: "filter", reason: "empty_optional" },
      { tool: "synthetic_search", field: "extra", reason: "unknown_field" },
    ]);
  });

  it("runs without a logger service", async () => {
    const tool = defineTool<never, z.infer<typeof parameters>>({
      name: "synthetic_search",
      description: "search",
      disclosure: "private",
      parameters,
      handler: () => Effect.succeed({ success: true, result: null }),
    });
    const outcome = await Effect.runPromise(
      tool.execute({ query: "q", filter: "" }, { agentId: "agent" } as ToolExecutionContext),
    );
    expect(outcome.success).toBe(true);
  });

  it("leaves tools that advertise their own JSON schema untouched", async () => {
    const tool = defineTool<never, Record<string, unknown>>({
      name: "synthetic_external",
      description: "external",
      disclosure: "private",
      parameters: z.object({ filter: z.string().optional() }).strict(),
      jsonSchema: { type: "object" },
      handler: () => Effect.succeed({ success: true, result: null }),
    });
    const outcome = await Effect.runPromise(
      tool.execute({ filter: "", extra: 1 }, { agentId: "agent" } as ToolExecutionContext),
    );
    expect(outcome.success).toBe(false);
  });
});
