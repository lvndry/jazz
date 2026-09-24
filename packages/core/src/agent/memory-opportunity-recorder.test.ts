import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { LoggerService } from "@/core/interfaces/logger";
import type { MemorySnapshot } from "@/core/interfaces/memory-service";
import { createMemoryOpportunityRecorder } from "./memory-opportunity-recorder";

const emptySnapshot: MemorySnapshot = { entries: [], unreadableScopes: [] };

function recordingLogger(): { logger: LoggerService; warnings: string[] } {
  const warnings: string[] = [];
  const logger = {
    warn: (message: string) =>
      Effect.sync(() => {
        warnings.push(message);
      }),
  } as unknown as LoggerService;
  return { logger, warnings };
}

describe("memory opportunity recorder", () => {
  let receiptsDirectory: string;
  let fileSystem: FileSystem.FileSystem;
  beforeEach(async () => {
    receiptsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-memory-recorder-"));
    fileSystem = await Effect.runPromise(
      FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)),
    );
  });
  afterEach(async () => {
    await fs.rm(receiptsDirectory, { recursive: true, force: true });
  });

  test("snapshots memory once per run until the run changes memory", async () => {
    let snapshots = 0;
    const { logger } = recordingLogger();
    const recorder = createMemoryOpportunityRecorder({
      snapshotEntries: () =>
        Effect.sync(() => {
          snapshots += 1;
          return emptySnapshot;
        }),
      fileSystem,
      logger,
      viewMemoryOffered: true,
      receiptsDirectory,
    });
    const request = { runId: "run-1", iteration: 0, messages: [] };
    await Effect.runPromise(recorder.begin(request));
    await Effect.runPromise(recorder.begin({ ...request, iteration: 1 }));
    expect(snapshots).toBe(1);
    recorder.invalidateSnapshot();
    await Effect.runPromise(recorder.begin({ ...request, iteration: 2 }));
    expect(snapshots).toBe(2);
  });

  test("logs a failed snapshot and records nothing instead of failing the request", async () => {
    const { logger, warnings } = recordingLogger();
    const recorder = createMemoryOpportunityRecorder({
      snapshotEntries: () => Effect.fail(new Error("disk unavailable")),
      fileSystem,
      logger,
      viewMemoryOffered: true,
      receiptsDirectory,
    });
    const tickets = await Effect.runPromise(
      recorder.begin({ runId: "run-2", iteration: 0, messages: [] }),
    );
    expect(tickets).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  test("logs scopes the snapshot had to skip", async () => {
    const { logger, warnings } = recordingLogger();
    const recorder = createMemoryOpportunityRecorder({
      snapshotEntries: () => Effect.succeed({ entries: [], unreadableScopes: ["work"] }),
      fileSystem,
      logger,
      viewMemoryOffered: true,
      receiptsDirectory,
    });
    await Effect.runPromise(recorder.begin({ runId: "run-3", iteration: 0, messages: [] }));
    expect(warnings).toEqual(["Some memory scopes could not be read for receipts"]);
  });
});
