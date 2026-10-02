import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { LoggerService } from "@/core/interfaces/logger";
import { MemoryServiceTag, type MemoryService } from "@/core/interfaces/memory-service";
import { resolveInjectedPreferences } from "./agent-runner";

const SILENT_LOGGER = {
  debug: () => Effect.void,
  warn: () => Effect.void,
} as unknown as LoggerService;

function memoryServiceWith(overrides: Partial<MemoryService>): MemoryService {
  return overrides as MemoryService;
}

function resolveWith(memoryService: MemoryService | undefined) {
  const effect = resolveInjectedPreferences(SILENT_LOGGER).pipe(
    Effect.provide(NodeFileSystem.layer),
  );
  return Effect.runPromise(
    memoryService === undefined
      ? effect
      : effect.pipe(Effect.provideService(MemoryServiceTag, memoryService)),
  );
}

describe("resolveInjectedPreferences", () => {
  test("returns standing and situational entries across every scope", async () => {
    const memoryService = memoryServiceWith({
      standingEntries: () =>
        Effect.succeed([
          { path: "personal/always/a.md", scope: "personal", topic: undefined, summary: "concise" },
        ]),
      conditionalEntries: () =>
        Effect.succeed([
          {
            path: "personal/when/writing-to-friends/a.md",
            scope: "personal",
            topic: "writing-to-friends",
            summary: "use humor",
          },
          {
            path: "personal/when/sending-email/b.md",
            scope: "personal",
            topic: "sending-email",
            summary: "sign off",
          },
        ]),
    });

    const result = await resolveWith(memoryService);

    expect(result.standing).toEqual([{ scope: "personal", summary: "concise" }]);
    expect(result.situational).toEqual([
      {
        scope: "personal",
        topic: "writing-to-friends",
        summary: "use humor",
        path: "personal/when/writing-to-friends/a.md",
      },
      {
        scope: "personal",
        topic: "sending-email",
        summary: "sign off",
        path: "personal/when/sending-email/b.md",
      },
    ]);
  });

  test("injects nothing when there is no memory service", async () => {
    expect(await resolveWith(undefined)).toEqual({ standing: [], situational: [] });
  });

  test("degrades to nothing when memory cannot be read", async () => {
    const memoryService = memoryServiceWith({
      standingEntries: () => Effect.succeed([]),
      conditionalEntries: () => Effect.fail(new Error("disk unavailable")),
    });

    expect(await resolveWith(memoryService)).toEqual({
      standing: [],
      situational: [],
    });
  });
});
