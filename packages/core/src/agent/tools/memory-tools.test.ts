import { NodeFileSystem } from "@effect/platform-node";
import { describe, test, expect } from "bun:test";
import { Effect } from "effect";
import type { MemoryService } from "@/core/interfaces/memory-service";
import { MemoryServiceTag } from "@/core/interfaces/memory-service";
import type { ToolExecutionContext } from "@/core/types/tools";
import { createManageMemoryTool, createViewMemoryTool } from "./memory-tools";

const context: ToolExecutionContext = { agentId: "agent-1" };

function runWithFakeMemoryService<A>(
  fakeService: MemoryService,
  eff: Effect.Effect<A, Error, MemoryService | import("@effect/platform").FileSystem.FileSystem>,
) {
  return Effect.runPromise(
    eff.pipe(
      Effect.provideService(MemoryServiceTag, fakeService),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
}

describe("view_memory tool", () => {
  test("has the expected shape", () => {
    const tool = createViewMemoryTool();
    expect(tool.name).toBe("view_memory");
    expect(tool.riskLevel).toBe("read-only");
    expect(tool.hidden).toBe(false);
  });

  test("formats an empty directory listing", async () => {
    const fakeService: Partial<MemoryService> = {
      view: () => Effect.succeed({ kind: "directory", path: "/", entries: [] }),
    };
    const tool = createViewMemoryTool();
    const result = await runWithFakeMemoryService(
      fakeService as MemoryService,
      tool.execute({ path: "" }, context),
    );
    expect(result.success).toBe(true);
  });

  test("surfaces not_found as a failed tool result", async () => {
    const fakeService: Partial<MemoryService> = {
      view: () =>
        Effect.succeed({ kind: "not_found", message: "The path /missing.txt does not exist." }),
    };
    const tool = createViewMemoryTool();
    const result = await runWithFakeMemoryService(
      fakeService as MemoryService,
      tool.execute({ path: "missing.txt" }, context),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("does not exist");
  });
});

describe("manage_memory tool", () => {
  test("has the expected shape", () => {
    const tool = createManageMemoryTool();
    expect(tool.name).toBe("manage_memory");
    expect(tool.riskLevel).toBe("low-risk");
    expect(tool.hidden).toBe(false);
  });

  test("dispatches create to the service and reports success", async () => {
    let receivedArgs: unknown[] = [];
    const fakeService: Partial<MemoryService> = {
      create: (...args) => {
        receivedArgs = args;
        return Effect.succeed({
          success: true,
          message: "File created successfully at: /notes.txt",
        });
      },
    };
    const tool = createManageMemoryTool();
    const result = await runWithFakeMemoryService(
      fakeService as MemoryService,
      tool.execute({ command: "create", path: "notes.txt", file_text: "hi" }, context),
    );
    expect(result.success).toBe(true);
    expect(receivedArgs).toEqual([["agent-1"], "notes.txt", "hi"]);
  });

  test("surfaces a failed mutation as a failed tool result", async () => {
    const fakeService: Partial<MemoryService> = {
      strReplace: () =>
        Effect.succeed({ success: false, message: "No replacement was performed." }),
    };
    const tool = createManageMemoryTool();
    const result = await runWithFakeMemoryService(
      fakeService as MemoryService,
      tool.execute(
        { command: "str_replace", path: "notes.txt", old_str: "x", new_str: "y" },
        context,
      ),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("No replacement was performed");
  });
});
