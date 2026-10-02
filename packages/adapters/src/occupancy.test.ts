import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OccupancyServiceTag, type OccupancyService } from "@jazz/core/interfaces/occupancy";
import type { OccupancyEntry } from "@jazz/core/types/occupancy";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { createOccupancyServiceLayer } from "./occupancy";

function occupancyPath(): string {
  return join(mkdtempSync(join(tmpdir(), "jazz-occupancy-")), "occupancy.json");
}

function withOccupancy<A, E>(
  path: string,
  program: Effect.Effect<A, E, OccupancyService>,
): Promise<A> {
  return Effect.runPromise(
    program.pipe(Effect.provide(createOccupancyServiceLayer({ filePath: path }))),
  );
}

const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function entry(overrides: Partial<OccupancyEntry> & { runId: string }): OccupancyEntry {
  return {
    agentId: "assistant",
    agentName: "Assistant",
    conversationId: "conv-1",
    workingDirectory: "/work/repo",
    state: "working",
    pid: process.pid,
    host: "localhost",
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("OccupancyService", () => {
  it("records an entry and lists it back", async () => {
    const path = occupancyPath();
    const entries = await withOccupancy(
      path,
      Effect.flatMap(OccupancyServiceTag, (service) =>
        service.record(entry({ runId: "run-1" })).pipe(Effect.zipRight(service.list())),
      ),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ runId: "run-1", workingDirectory: "/work/repo" });
  });

  it("keeps both entries when two runs heartbeat the same file", async () => {
    const path = occupancyPath();
    await withOccupancy(
      path,
      Effect.flatMap(OccupancyServiceTag, (service) =>
        service
          .record(entry({ runId: "run-1" }))
          .pipe(Effect.zipRight(service.record(entry({ runId: "run-2" })))),
      ),
    );
    const entries = await withOccupancy(
      path,
      Effect.flatMap(OccupancyServiceTag, (service) => service.list()),
    );
    expect(entries.map((e) => e.runId).sort()).toEqual(["run-1", "run-2"]);
  });

  it("updates an entry in place on a later heartbeat", async () => {
    const path = occupancyPath();
    await withOccupancy(
      path,
      Effect.flatMap(OccupancyServiceTag, (service) =>
        service
          .record(entry({ runId: "run-1", state: "working" }))
          .pipe(Effect.zipRight(service.record(entry({ runId: "run-1", state: "completed" })))),
      ),
    );
    const entries = await withOccupancy(
      path,
      Effect.flatMap(OccupancyServiceTag, (service) => service.list()),
    );
    expect(entries).toHaveLength(1);
    const recorded = entries[0]!;
    expect(recorded.state).toBe("completed");
  });
  it("drops a working entry whose heartbeat went stale", async () => {
    const path = occupancyPath();
    await withOccupancy(
      path,
      Effect.flatMap(OccupancyServiceTag, (service) =>
        service.record(entry({ runId: "stale", updatedAt: ago(10 * 60_000) })),
      ),
    );
    const entries = await withOccupancy(
      path,
      Effect.flatMap(OccupancyServiceTag, (service) => service.list()),
    );
    expect(entries).toHaveLength(0);
  });

  it("drops a terminal entry once its short visibility window passed", async () => {
    const path = occupancyPath();
    await withOccupancy(
      path,
      Effect.flatMap(OccupancyServiceTag, (service) =>
        service.record(entry({ runId: "done", state: "completed", updatedAt: ago(10 * 60_000) })),
      ),
    );
    const entries = await withOccupancy(
      path,
      Effect.flatMap(OccupancyServiceTag, (service) => service.list()),
    );
    expect(entries).toHaveLength(0);
  });

  it("returns an empty registry for a corrupt file", async () => {
    const path = occupancyPath();
    writeFileSync(path, "{ not json");
    const entries = await withOccupancy(
      path,
      Effect.flatMap(OccupancyServiceTag, (service) => service.list()),
    );
    expect(entries).toEqual([]);
  });

  it("lists nothing for a file that is not yet written", async () => {
    const path = occupancyPath();
    const entries = await withOccupancy(
      path,
      Effect.flatMap(OccupancyServiceTag, (service) => service.list()),
    );
    expect(entries).toEqual([]);
  });
});
