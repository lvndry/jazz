import { FileSystem } from "@effect/platform";
import { describe, expect, it, mock } from "bun:test";
import { Effect, Layer } from "effect";
import { JazzStateServiceTag } from "@/core/interfaces/jazz-state";
import { createJazzStateServiceLayer } from "./jazz-state";

const mockFS = {
  exists: mock(() => Effect.succeed(false)),
  makeDirectory: mock(() => Effect.void),
  readFileString: mock(() => Effect.succeed("{}")),
  writeFileString: mock(() => Effect.void),
} as unknown as FileSystem.FileSystem;

const createService = () =>
  createJazzStateServiceLayer().pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, mockFS)));

describe("JazzStateService", () => {
  it("returns undefined for missing keys", async () => {
    const layer = createService();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* JazzStateServiceTag;
        return yield* state.get("wizard.lastUsedAgentId");
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toBeUndefined();
  });

  it("sets and persists a value", async () => {
    const layer = createService();
    await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* JazzStateServiceTag;
        yield* state.set("wizard.lastUsedAgentId", "agent-123");
      }).pipe(Effect.provide(layer)),
    );

    expect(mockFS.writeFileString).toHaveBeenCalled();
    const written = (mockFS.writeFileString as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][1];
    expect(written).toContain("agent-123");
  });

  it("loads previously persisted state", async () => {
    const fs = {
      ...mockFS,
      exists: mock(() => Effect.succeed(true)),
      readFileString: mock(() =>
        Effect.succeed(JSON.stringify({ wizard: { lastUsedAgentId: "agent-456" } })),
      ),
    } as unknown as FileSystem.FileSystem;

    const layer = createJazzStateServiceLayer().pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* JazzStateServiceTag;
        return yield* state.get("wizard.lastUsedAgentId");
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toBe("agent-456");
  });
});
