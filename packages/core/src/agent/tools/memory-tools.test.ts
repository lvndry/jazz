/** The model-facing memory tools must honor authenticated user sources at every mutation. */

import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { MemoryService } from "@/core/interfaces/memory-service";
import { MemoryServiceTag } from "@/core/interfaces/memory-service";
import type { ToolExecutionContext } from "@/core/types/tools";
import { createManageMemoryTool, createViewMemoryTool } from "./memory-tools";

const context: ToolExecutionContext = {
  agentId: "agent-1",
  memoryScopes: ["personal"],
  memoryUserSources: [{ id: "user:1", text: "My favorite fruit is banana." }],
};

function runWithMemory<A>(
  service: MemoryService,
  effect: Effect.Effect<A, Error, MemoryService | import("@effect/platform").FileSystem.FileSystem>,
) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provideService(MemoryServiceTag, service),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
}

describe("view_memory", () => {
  test("formats an empty directory and reports a missing path", async () => {
    const tool = createViewMemoryTool();
    expect(tool.riskLevel).toBe("read-only");
    const service: Partial<MemoryService> = {
      view: (_scopes, path) =>
        Effect.succeed(
          path === ""
            ? { kind: "directory", path: "/", entries: [] }
            : { kind: "not_found", message: "No such memory" },
        ),
    };
    expect(
      (await runWithMemory(service as MemoryService, tool.execute({ path: "" }, context))).success,
    ).toBe(true);
    const missing = await runWithMemory(
      service as MemoryService,
      tool.execute({ path: "missing" }, context),
    );
    expect(missing.success).toBe(false);
    expect(missing.error).toContain("No such memory");
  });
});

describe("manage_memory", () => {
  const citation = { source_ref: "user:1", source_quote: "My favorite fruit is banana." };

  test("stores only the exact authenticated claim in a topic-scoped entry", async () => {
    const calls: unknown[][] = [];
    const service: Partial<MemoryService> = {
      create: (...args) => {
        calls.push(args);
        return Effect.succeed({ success: true, message: "created" });
      },
    };
    const result = await runWithMemory(
      service as MemoryService,
      createManageMemoryTool().execute(
        { command: "create", subject: "Favorite fruit", topic: "Food", ...citation },
        context,
      ),
    );
    expect(result.success).toBe(true);
    expect(calls[0]?.[1]).toBe("personal/when/food/favorite-fruit.md");
    expect(calls[0]?.[2]).toBe('The user said: "My favorite fruit is banana."\n');
    expect(calls[0]?.[3]).toMatchObject({
      sourceRef: "user:1",
      entry: { origin: "user" },
    });
  });

  test("rejects tool claims and forged source refs before calling storage", async () => {
    let writes = 0;
    const service: Partial<MemoryService> = {
      create: () => {
        writes += 1;
        return Effect.succeed({ success: true, message: "created" });
      },
    };
    for (const bad of [
      { source_ref: "tool:7", source_quote: "My favorite fruit is pineapple." },
      { source_ref: "user:1", source_quote: "My favorite fruit is pineapple." },
    ]) {
      const result = await runWithMemory(
        service as MemoryService,
        createManageMemoryTool().execute(
          { command: "create", subject: "Favorite fruit", topic: "Food", ...bad },
          context,
        ),
      );
      expect(result.success).toBe(false);
    }
    expect(writes).toBe(0);
  });

  test("does not persist a cited API key claim", async () => {
    let writes = 0;
    const service: Partial<MemoryService> = {
      create: () => {
        writes += 1;
        return Effect.succeed({ success: true, message: "created" });
      },
    };
    const claim = "My API key is abc123.";
    const result = await runWithMemory(
      service as MemoryService,
      createManageMemoryTool().execute(
        {
          command: "create",
          subject: "API key",
          source_ref: "user:secret",
          source_quote: claim,
        },
        { ...context, memoryUserSources: [{ id: "user:secret", text: claim }] },
      ),
    );
    expect(result.success).toBe(false);
    expect(writes).toBe(0);
  });

  test("does not turn a forget instruction into a new fact", async () => {
    let writes = 0;
    const service: Partial<MemoryService> = {
      create: () => {
        writes += 1;
        return Effect.succeed({ success: true, message: "created" });
      },
    };
    const result = await runWithMemory(
      service as MemoryService,
      createManageMemoryTool().execute(
        {
          command: "create",
          subject: "favorite fruit",
          source_ref: "user:forget",
          source_quote: "Forget my favorite fruit.",
        },
        {
          ...context,
          memoryUserSources: [{ id: "user:forget", text: "Forget my favorite fruit." }],
        },
      ),
    );
    expect(result.success).toBe(false);
    expect(writes).toBe(0);
  });

  test("amends against the complete current file with the user's correction", async () => {
    const correction = "Actually, my favorite fruit is mango.";
    let replacement: readonly unknown[] | undefined;
    const service: Partial<MemoryService> = {
      view: () =>
        Effect.succeed({
          kind: "file",
          path: "personal/when/food/favorite-fruit.md",
          content: 'The user said: "My favorite fruit is banana."\n',
          startLine: 1,
          totalLines: 2,
          truncated: false,
        }),
      strReplace: (...args) => {
        replacement = args;
        return Effect.succeed({ success: true, message: "amended" });
      },
    };
    const result = await runWithMemory(
      service as MemoryService,
      createManageMemoryTool().execute(
        {
          command: "amend",
          path: "personal/when/food/favorite-fruit.md",
          source_ref: "user:2",
          source_quote: correction,
        },
        { ...context, memoryUserSources: [{ id: "user:2", text: correction }] },
      ),
    );
    expect(result.success).toBe(true);
    expect(replacement?.[2]).toBe('The user said: "My favorite fruit is banana."\n');
    expect(replacement?.[3]).toBe('The user said: "Actually, my favorite fruit is mango."\n');
  });

  test("requires an explicit authenticated request to forget", async () => {
    let deletes = 0;
    const service: Partial<MemoryService> = {
      delete: () => {
        deletes += 1;
        return Effect.succeed({ success: true, message: "deleted" });
      },
    };
    const tool = createManageMemoryTool();
    const passive = await runWithMemory(
      service as MemoryService,
      tool.execute(
        { command: "delete", path: "personal/when/food/favorite-fruit.md", ...citation },
        context,
      ),
    );
    expect(passive.success).toBe(false);
    const direct = await runWithMemory(
      service as MemoryService,
      tool.execute(
        {
          command: "delete",
          path: "personal/when/food/favorite-fruit.md",
          source_ref: "user:3",
          source_quote: "Forget my favorite fruit.",
        },
        { ...context, memoryUserSources: [{ id: "user:3", text: "Forget my favorite fruit." }] },
      ),
    );
    expect(direct.success).toBe(true);
    expect(deletes).toBe(1);
  });
});
