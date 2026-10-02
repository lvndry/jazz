import { hostname } from "node:os";
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { FileSystemContextServiceTag } from "@/core/interfaces/fs";
import { OccupancyServiceTag, type OccupancyService } from "@/core/interfaces/occupancy";
import type { OccupancyEntry } from "@/core/types/occupancy";
import type { ToolExecutionContext } from "@/core/types/tools";
import { createWhoIsHereTool } from "./occupancy";

const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function entry(overrides: Partial<OccupancyEntry> & { runId: string }): OccupancyEntry {
  return {
    agentId: "assistant",
    agentName: "Assistant",
    conversationId: "conv-1",
    workingDirectory: "/work/repo",
    state: "working",
    // A live pid that is NOT the test process, so the self-exclusion filter keeps these
    // occupants. pid 1 (init) is always alive on the same host.
    pid: 1,
    host: hostname(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function occupancyLayer(entries: readonly OccupancyEntry[]): Layer.Layer<OccupancyService, never> {
  return Layer.succeed(OccupancyServiceTag, {
    record: () => Effect.void,
    list: () => Effect.succeed(entries),
  });
}

function cwdLayer(cwd: string) {
  return Layer.succeed(FileSystemContextServiceTag, {
    getCwd: () => Effect.succeed(cwd),
    setCwd: () => Effect.void,
    resolvePath: () => Effect.succeed(cwd),
    findDirectory: () => Effect.succeed({ results: [] }),
    resolvePathForMkdir: () => Effect.succeed(cwd),
    escapePath: (p) => p,
  });
}

const CONTEXT = { agentId: "assistant" } satisfies ToolExecutionContext;

function runTool(entries: readonly OccupancyEntry[], cwd = "/work/repo") {
  return Effect.runPromise(
    createWhoIsHereTool()
      .execute({}, CONTEXT)
      .pipe(Effect.provide(Layer.merge(occupancyLayer(entries), cwdLayer(cwd)))),
  );
}

describe("who_is_here", () => {
  it("reports nobody when the registry is empty", async () => {
    const result = await runTool([]);
    expect(result.success).toBe(true);
    if (result.success) expect(result.result).toContain("nobody is working here");
  });

  it("bands a fresh mutating occupant as WRITING with tool and path", async () => {
    const result = await runTool([
      entry({
        runId: "a".repeat(8),
        lastMutatingAt: ago(5_000),
        lastMutatingTool: "write_file",
        lastMutatingPath: "src/a.ts",
      }),
    ]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toContain("WRITING here — last write 5s ago");
      expect(result.result).toContain("via write_file");
      expect(result.result).toContain("touched src/a.ts");
    }
  });

  it("bands an old mutating call as wrote-idle, not writing", async () => {
    const result = await runTool([
      entry({ runId: "b".repeat(8), lastMutatingAt: ago(10 * 60_000) }),
    ]);
    if (result.success) {
      expect(result.result).toContain("wrote earlier this run, idle since");
      expect(result.result).not.toContain("WRITING here");
    }
  });

  it("bands an occupant with no mutating call as reads only", async () => {
    const result = await runTool([entry({ runId: "c".repeat(8), lastReadAt: ago(1_000) })]);
    if (result.success) expect(result.result).toContain("present, reads only");
  });

  it("drops an occupant whose heartbeat went stale", async () => {
    const result = await runTool([entry({ runId: "d".repeat(8), updatedAt: ago(10 * 60_000) })]);
    if (result.success) expect(result.result).toContain("nobody is working here");
  });

  it("drops an occupant whose process died", async () => {
    const result = await runTool([entry({ runId: "e".repeat(8), pid: 999_999 })]);
    if (result.success) expect(result.result).toContain("nobody is working here");
  });

  it("drops a finished run: its final entry is terminal even though it is fresh", async () => {
    const result = await runTool([
      entry({ runId: "j".repeat(8), state: "completed", updatedAt: ago(500) }),
    ]);
    if (result.success) expect(result.result).toContain("nobody is working here");
  });

  it("does not report the caller's own heartbeat", async () => {
    const result = await runTool([
      entry({ runId: "f".repeat(8), pid: process.pid, host: hostname() }),
    ]);
    if (result.success) expect(result.result).toContain("nobody is working here");
  });

  it("lists an occupant in a subdirectory of the queried directory", async () => {
    const result = await runTool([
      entry({ runId: "g".repeat(8), workingDirectory: "/work/repo/packages/core" }),
    ]);
    if (result.success) {
      expect(result.result).not.toContain("nobody is working here");
      expect(result.result).not.toContain("elsewhere on this machine");
    }
  });

  it("lists an occupant in a sibling directory under elsewhere", async () => {
    const result = await runTool([
      entry({ runId: "h".repeat(8), workingDirectory: "/work/other" }),
    ]);
    if (result.success) {
      expect(result.result).toContain("elsewhere on this machine");
      expect(result.result).toContain("/work/other");
    }
  });

  it("states a waiting-on-approval occupant explicitly", async () => {
    const result = await runTool([entry({ runId: "i".repeat(8), state: "input-required" })]);
    if (result.success) expect(result.result).toContain("waiting on approval");
  });
});
