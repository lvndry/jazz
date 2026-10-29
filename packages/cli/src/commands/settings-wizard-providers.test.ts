/**
 * `/settings` → Model providers: provider options stay reachable when a key is already stored.
 *
 * Copying a stored key spawns a clipboard command, so `PATH` points at an empty directory and the
 * copy fails harmlessly instead of touching the developer's clipboard.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import type { AppConfig } from "@jazz/core/types/config";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { configureLLMProviders } from "./settings-wizard";

let originalPath: string | undefined;

beforeEach(() => {
  originalPath = process.env["PATH"];
  process.env["PATH"] = mkdtempSync(path.join(tmpdir(), "jazz-settings-empty-path-"));
});

afterEach(() => {
  if (originalPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = originalPath;
});

interface Script {
  readonly keyAction: string | undefined;
  readonly zdrAnswer: boolean | undefined;
}

async function configureOpenRouter(script: Script, zdr?: boolean) {
  const writes: Array<{ key: string; value: unknown }> = [];
  const confirmPrompts: string[] = [];
  let selections = 0;
  const config = {
    llm: { openrouter: { api_key: "sk-or-test", ...(zdr !== undefined ? { zdr } : {}) } },
  } as unknown as AppConfig;

  const terminal = {
    isInteractive: true,
    select: () => Effect.succeed(selections++ === 0 ? "openrouter" : "back"),
    ask: () => Effect.succeed(script.keyAction),
    confirm: (message: string) => {
      confirmPrompts.push(message);
      return Effect.succeed(script.zdrAnswer);
    },
    log: () => Effect.succeed(undefined),
    info: () => Effect.void,
    success: () => Effect.void,
    error: () => Effect.void,
  } as unknown as TerminalService;

  const configService = {
    appConfig: Effect.succeed(config),
    set: (key: string, value: unknown) => Effect.sync(() => void writes.push({ key, value })),
  } as unknown as AgentConfigService;

  await Effect.runPromise(
    configureLLMProviders().pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(TerminalServiceTag, terminal),
          Layer.succeed(AgentConfigServiceTag, configService),
        ),
      ),
    ),
  );
  return { writes, confirmPrompts };
}

describe("OpenRouter zero data retention in /settings", () => {
  it("is offered after copying a stored key, without asking for a new one", async () => {
    const { writes, confirmPrompts } = await configureOpenRouter({
      keyAction: "c",
      zdrAnswer: true,
    });

    expect(confirmPrompts).toHaveLength(1);
    expect(writes).toEqual([{ key: "llm.openrouter.zdr", value: true }]);
  });

  it("is not offered when the stored-key prompt is dismissed", async () => {
    const { writes, confirmPrompts } = await configureOpenRouter({
      keyAction: undefined,
      zdrAnswer: true,
    });

    expect(confirmPrompts).toHaveLength(0);
    expect(writes).toEqual([]);
  });

  it("writes nothing when the answer matches the current setting", async () => {
    const { writes } = await configureOpenRouter({ keyAction: "c", zdrAnswer: true }, true);

    expect(writes).toEqual([]);
  });
});
