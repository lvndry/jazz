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
  it("offers the goal day and month caps first, and chat's default cap last", () => {
    expect(SPEND_LIMIT_SETTINGS.slice(0, 2).map((setting) => setting.key)).toEqual([
      "daemon.goals.dailyCostUSD",
      "daemon.goals.monthlyCostUSD",
    ]);
    expect(SPEND_LIMIT_SETTINGS.at(-1)?.key).toBe("chat.defaultCostLimitUSD");
  });

  it("reads the chat default cap from config.chat, not config.daemon", () => {
    const setting = SPEND_LIMIT_SETTINGS.find(
      (candidate) => candidate.key === "chat.defaultCostLimitUSD",
    );
    expect(setting?.read({ chat: { defaultCostLimitUSD: 2.5 } } as AppConfig)).toBe(2.5);
    expect(setting?.read({} as AppConfig)).toBeUndefined();
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
      applySpendLimit(service, "daemon.goals.dailyCostUSD", { kind: "limit", dollars: 3 }),
    );
    await Effect.runPromise(
      applySpendLimit(service, "daemon.goals.monthlyCostUSD", { kind: "limit", dollars: 40 }),
    );
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    await Effect.runPromise(
      applySpendLimit(service, "daemon.goals.dailyCostUSD", { kind: "unlimited" }),
    );
    const cleared = JSON.parse(readFileSync(configPath, "utf8"));

    expect(written.daemon).toEqual({ goals: { dailyCostUSD: 3, monthlyCostUSD: 40 } });
    expect(cleared.daemon).toEqual({ goals: { monthlyCostUSD: 40 } });
  });

  it("writes chat's default cap to config.json and removes it again when set to unlimited", async () => {
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
      applySpendLimit(service, "chat.defaultCostLimitUSD", { kind: "limit", dollars: 2.5 }),
    );
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    await Effect.runPromise(
      applySpendLimit(service, "chat.defaultCostLimitUSD", { kind: "unlimited" }),
    );
    const cleared = JSON.parse(readFileSync(configPath, "utf8"));

    expect(written.chat).toEqual({ defaultCostLimitUSD: 2.5 });
    expect(cleared.chat).toBeUndefined();
  });
});
