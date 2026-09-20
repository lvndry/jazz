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

  function captureCreate() {
    const captured: { args: unknown[] } = { args: [] };
    const fakeService: Partial<MemoryService> = {
      create: (...args) => {
        captured.args = args;
        return Effect.succeed({ success: true, message: "File created successfully at: /x.md" });
      },
    };
    return { captured, fakeService };
  }

  test("derives a fact's path from its subject so the caller cannot misfile it", async () => {
    const { captured, fakeService } = captureCreate();
    const result = await runWithFakeMemoryService(
      fakeService as MemoryService,
      createManageMemoryTool().execute(
        { command: "create", kind: "fact", subject: "Home timezone", file_text: "Paris" },
        context,
      ),
    );
    expect(result.success).toBe(true);
    expect(captured.args[1]).toBe("agent-1/facts/home-timezone.md");
    expect(captured.args[3]).toMatchObject({
      agentId: "agent-1",
      entry: { subject: "home-timezone", origin: "user" },
    });
  });

  test("files a preference with no workflow under _global", async () => {
    const { captured, fakeService } = captureCreate();
    await runWithFakeMemoryService(
      fakeService as MemoryService,
      createManageMemoryTool().execute(
        {
          command: "create",
          kind: "preference",
          subject: "Rendered output opening",
          file_text: "auto-open renders",
        },
        context,
      ),
    );
    expect(captured.args[1]).toBe("agent-1/preferences/_global/rendered-output-opening.md");
  });

  test("files a workflow-scoped preference under its workflow, not a directory", async () => {
    const { captured, fakeService } = captureCreate();
    await runWithFakeMemoryService(
      fakeService as MemoryService,
      createManageMemoryTool().execute(
        {
          command: "create",
          kind: "preference",
          subject: "Artboard scaling",
          workflow: "Mood Board",
          file_text: "artboards auto-scale",
        },
        context,
      ),
    );
    expect(captured.args[1]).toBe("agent-1/preferences/mood-board/artboard-scaling.md");
  });

  test("records a lesson's trigger so the loop can score it later", async () => {
    const { captured, fakeService } = captureCreate();
    await runWithFakeMemoryService(
      fakeService as MemoryService,
      createManageMemoryTool().execute(
        {
          command: "create",
          kind: "lesson",
          subject: "Edit pattern complexity",
          workflow: "editing",
          failure: {
            kind: "misfire",
            tool_name: "edit_file",
            error_class: "pattern too complex",
          },
          file_text: "prefer a literal snippet over a broad pattern",
        },
        context,
      ),
    );
    expect(captured.args[3]).toMatchObject({
      entry: {
        failure: { kind: "misfire", toolName: "edit_file", errorClass: "pattern too complex" },
      },
    });
  });

  test("rejects a lesson with no failure, which could never be validated", async () => {
    const { fakeService } = captureCreate();
    const result = await runWithFakeMemoryService(
      fakeService as MemoryService,
      createManageMemoryTool().execute(
        { command: "create", kind: "lesson", subject: "Something", file_text: "x" },
        context,
      ),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("failure");
  });

  test("accepts a lesson that names its trigger", async () => {
    const { fakeService } = captureCreate();
    const result = await runWithFakeMemoryService(
      fakeService as MemoryService,
      createManageMemoryTool().execute(
        {
          command: "create",
          kind: "lesson",
          subject: "Something",
          file_text: "x",
          failure: { kind: "correction", corrected_behavior: "do it differently" },
        },
        context,
      ),
    );
    expect(result.success).toBe(true);
  });

  test("marks an entry written by the extraction pass as auto rather than user-stated", async () => {
    const { captured, fakeService } = captureCreate();
    await runWithFakeMemoryService(
      fakeService as MemoryService,
      createManageMemoryTool().execute(
        { command: "create", kind: "fact", subject: "Timezone", file_text: "Paris" },
        { ...context, agentId: "memory-extractor" },
      ),
    );
    expect(captured.args[3]).toMatchObject({ entry: { origin: "auto" } });
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
