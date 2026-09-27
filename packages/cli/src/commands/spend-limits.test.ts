import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { AgentConfigServiceImpl } from "@jazz/adapters/config";
import type { AppConfig } from "@jazz/core/types/config";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { applySpendLimit, parseSpendLimitInput, SPEND_LIMIT_SETTINGS } from "./spend-limits";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("parseSpendLimitInput", () => {
  it("reads dollars, and reads empty or 'unlimited' as no limit", () => {
    expect(parseSpendLimitInput("5")).toEqual({ kind: "limit", dollars: 5 });
    expect(parseSpendLimitInput(" $12.505 ")).toEqual({ kind: "limit", dollars: 12.51 });
    expect(parseSpendLimitInput("")).toEqual({ kind: "unlimited" });
    expect(parseSpendLimitInput("Unlimited")).toEqual({ kind: "unlimited" });
    expect(parseSpendLimitInput("five").kind).toBe("invalid");
    expect(parseSpendLimitInput("-3").kind).toBe("invalid");
  });
});

describe("wizard spend limits", () => {
  it("offers the goal day and month caps first", () => {
    expect(SPEND_LIMIT_SETTINGS.slice(0, 2).map((setting) => setting.key)).toEqual([
      "spend.goals.dayUSD",
      "spend.goals.monthUSD",
    ]);
  });

  it("writes a goal cap to config.json and removes it again when set to unlimited", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "jazz-spend-limits-"));
    directories.push(directory);
    const configPath = path.join(directory, "config.json");
    const service = await Effect.runPromise(
      Effect.map(
        FileSystem.FileSystem,
        (fs) => new AgentConfigServiceImpl({} as AppConfig, {}, configPath, fs),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    );

    await Effect.runPromise(
      applySpendLimit(service, "spend.goals.dayUSD", { kind: "limit", dollars: 3 }),
    );
    await Effect.runPromise(
      applySpendLimit(service, "spend.goals.monthUSD", { kind: "limit", dollars: 40 }),
    );
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    await Effect.runPromise(applySpendLimit(service, "spend.goals.dayUSD", { kind: "unlimited" }));
    const cleared = JSON.parse(readFileSync(configPath, "utf8"));

    expect(written.spend).toEqual({ goals: { dayUSD: 3, monthUSD: 40 } });
    expect(cleared.spend).toEqual({ goals: { monthUSD: 40 } });
  });
});
