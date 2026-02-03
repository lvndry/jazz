import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  DiffExpansionServiceTag,
  DiffExpansionServiceLive,
  registerTruncatedDiff,
  getExpandableDiff,
  clearExpandableDiff,
  hasExpandableDiff,
  type DiffExpansionService,
  type TruncatedDiffInfo,
} from "./diff-expansion-service";

// Test data factory
const createTestDiffInfo = (overrides?: Partial<TruncatedDiffInfo>): TruncatedDiffInfo => ({
  request: {
    originalContent: "original content",
    newContent: "new content",
    filepath: "test.ts",
    options: {}
  },
  truncatedAtLine: 10,
  totalChanges: 5,
  timestamp: Date.now(),
  ...overrides
});

const runWithService = <A, E>(
  program: Effect.Effect<A, E, DiffExpansionService>
): Promise<A> => {
  return Effect.runPromise(Effect.provide(program, DiffExpansionServiceLive));
};

describe("DiffExpansionService", () => {
  test("registerTruncatedDiff stores diff info", async () => {
    const testInfo = createTestDiffInfo();

    const result = await runWithService(
      Effect.gen(function* () {
        const service = yield* DiffExpansionServiceTag;
        yield* service.registerTruncatedDiff(testInfo);
        return yield* service.getExpandableDiff();
      })
    );

    expect(result).toEqual(testInfo);
  });

  test("hasExpandableDiff returns false when no diff is registered", async () => {
    const result = await runWithService(hasExpandableDiff());
    expect(result).toBe(false);
  });

  test("hasExpandableDiff returns true when diff is registered", async () => {
    const testInfo = createTestDiffInfo();

    const result = await runWithService(
      Effect.gen(function* () {
        yield* registerTruncatedDiff(testInfo);
        return yield* hasExpandableDiff();
      })
    );

    expect(result).toBe(true);
  });

  test("clearExpandableDiff removes the stored diff", async () => {
    const testInfo = createTestDiffInfo();

    const result = await runWithService(
      Effect.gen(function* () {
        yield* registerTruncatedDiff(testInfo);
        yield* clearExpandableDiff();
        return yield* getExpandableDiff();
      })
    );

    expect(result).toBeNull();
  });

  test("registerTruncatedDiff overwrites previous diff", async () => {
    const firstInfo = createTestDiffInfo({
      request: {
        originalContent: "original content",
        newContent: "new content",
        filepath: "first.ts",
      },
    });
    const secondInfo = createTestDiffInfo({
      request: {
        originalContent: "original content",
        newContent: "new content",
        filepath: "second.ts",
      },
    });

    const result = await runWithService(
      Effect.gen(function* () {
        yield* registerTruncatedDiff(firstInfo);
        yield* registerTruncatedDiff(secondInfo);
        return yield* getExpandableDiff();
      })
    );

    expect(result).toEqual(secondInfo);
  });
});
