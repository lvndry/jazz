import type { AppConfig } from "@jazz/core/types/config";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  applyRunLimit,
  describeRunLimit,
  parseRunLimitInput,
  RUN_LIMIT_SETTINGS,
} from "./run-limits";

describe("parseRunLimitInput", () => {
  it("reads a whole number of iterations", () => {
    expect(parseRunLimitInput("500")).toEqual({ kind: "limit", iterations: 500 });
  });

  it("treats empty and the default words as the default", () => {
    expect(parseRunLimitInput("")).toEqual({ kind: "default" });
    expect(parseRunLimitInput("  ")).toEqual({ kind: "default" });
    expect(parseRunLimitInput("default")).toEqual({ kind: "default" });
    expect(parseRunLimitInput("NONE")).toEqual({ kind: "default" });
  });

  it("refuses zero, negatives, fractions and words with a reason", () => {
    for (const raw of ["0", "-3", "1.5", "many", "12abc", "$5"]) {
      expect(parseRunLimitInput(raw).kind, raw).toBe("invalid");
    }
  });
});

describe("describeRunLimit", () => {
  it("renders the default for an unset limit and the number otherwise", () => {
    expect(describeRunLimit(undefined)).toBe("default");
    expect(describeRunLimit(120)).toBe("120");
  });
});

describe("applyRunLimit", () => {
  it("writes a limit, and removes the key for the default", async () => {
    const sets: Array<[string, number | undefined]> = [];
    const configService = {
      set: <A>(key: string, value: A) =>
        Effect.sync<void>(() => sets.push([key, value as number | undefined])),
    };

    await Effect.runPromise(
      applyRunLimit(configService, "maxIterations", { kind: "limit", iterations: 60 }),
    );
    await Effect.runPromise(applyRunLimit(configService, "maxIterations", { kind: "default" }));

    expect(sets).toEqual([
      ["maxIterations", 60],
      ["maxIterations", undefined],
    ]);
  });
});

describe("RUN_LIMIT_SETTINGS", () => {
  it("exposes the top-level run before its sub-agents, reading the right config keys", () => {
    const config = { maxIterations: 111, maxSubagentIterations: 22 } as AppConfig;
    expect(RUN_LIMIT_SETTINGS.map((setting) => setting.key)).toEqual([
      "maxIterations",
      "maxSubagentIterations",
    ]);
    expect(RUN_LIMIT_SETTINGS.map((setting) => setting.read(config))).toEqual([111, 22]);
  });
});
