import { FileSystem } from "@effect/platform";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Effect, Layer } from "effect";
import { JazzStateServiceTag } from "@/core/interfaces/jazz-state";
import { createJazzStateServiceLayer } from "./jazz-state";

const existsMock = mock(() => Effect.succeed(false));
const makeDirectoryMock = mock(() => Effect.void);
const readFileStringMock = mock(() => Effect.succeed("{}"));
const writeFileStringMock = mock(() => Effect.void);

const mockFS = {
  exists: existsMock,
  makeDirectory: makeDirectoryMock,
  readFileString: readFileStringMock,
  writeFileString: writeFileStringMock,
} as unknown as FileSystem.FileSystem;

const createService = () =>
  createJazzStateServiceLayer().pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, mockFS)));

describe("JazzStateService", () => {
  beforeEach(() => {
    existsMock.mockClear();
    makeDirectoryMock.mockClear();
    readFileStringMock.mockClear();
    writeFileStringMock.mockClear();
  });

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

    expect(writeFileStringMock).toHaveBeenCalled();
    const written = (writeFileStringMock as unknown as { mock: { calls: unknown[][] } }).mock
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

  it("falls back to empty state when persisted file is a JSON array", async () => {
    const fs = {
      ...mockFS,
      exists: mock(() => Effect.succeed(true)),
      readFileString: mock(() => Effect.succeed("[]")),
    } as unknown as FileSystem.FileSystem;

    const layer = createJazzStateServiceLayer().pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* JazzStateServiceTag;
        yield* state.set("wizard.lastUsedAgentId", "agent-789");
        return yield* state.get("wizard.lastUsedAgentId");
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toBe("agent-789");
  });

  it("ignores prototype-pollution paths", async () => {
    const layer = createService();
    await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* JazzStateServiceTag;
        yield* state.set("__proto__.polluted", true);
        yield* state.set("constructor.prototype.polluted", true);
      }).pipe(Effect.provide(layer)),
    );

    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });
});
