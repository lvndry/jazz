/**
 * `llm.openrouter.zdr` from a project config: a cloned repository may turn zero data retention
 * on, but never off over a user's global setting.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import { getGlobalConfigFilePath } from "@jazz/core/utils/paths";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { createConfigLayer } from "./config";

const ENV_KEYS = ["JAZZ_HOME"] as const;
let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;
let originalCwd: string;

beforeEach(() => {
  originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  originalCwd = process.cwd();
  process.env["JAZZ_HOME"] = mkdtempSync(path.join(tmpdir(), "jazz-zdr-home-"));
  process.chdir(mkdtempSync(path.join(tmpdir(), "jazz-zdr-project-")));
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function writeGlobalConfig(document: unknown): void {
  const configPath = getGlobalConfigFilePath();
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(document, null, 2));
}

function writeProjectConfig(document: unknown): void {
  mkdirSync(".jazz");
  writeFileSync(path.join(".jazz", "config.json"), JSON.stringify(document));
}

function loadZdr(changeSetting?: { key: string; value: unknown }) {
  const layer = createConfigLayer().pipe(Layer.provide(NodeFileSystem.layer));
  return Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* AgentConfigServiceTag;
      if (changeSetting !== undefined) {
        yield* config.set(changeSetting.key, changeSetting.value);
      }
      return (yield* config.appConfig).llm?.openrouter?.zdr;
    }).pipe(Effect.provide(layer)),
  );
}

async function quietly<T>(run: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await run(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

describe("llm.openrouter.zdr in a project config", () => {
  it("cannot turn off a global true, and says why", async () => {
    writeGlobalConfig({ llm: { openrouter: { zdr: true } } });
    writeProjectConfig({ llm: { openrouter: { zdr: false } } });

    const { result: zdr, stderr } = await quietly(() => loadZdr());

    expect(zdr).toBe(true);
    expect(stderr).toContain("ignoring llm.openrouter.zdr: false");
  });

  it("stays on after another setting changes and the config is rebuilt", async () => {
    writeGlobalConfig({ llm: { openrouter: { zdr: true } } });
    writeProjectConfig({ llm: { openrouter: { zdr: false } } });

    const { result: zdr } = await quietly(() =>
      loadZdr({ key: "output.showReasoning", value: false }),
    );

    expect(zdr).toBe(true);
  });

  it("can turn it on when the global config leaves it unset", async () => {
    writeGlobalConfig({});
    writeProjectConfig({ llm: { openrouter: { zdr: true } } });

    const { result: zdr, stderr } = await quietly(() => loadZdr());

    expect(zdr).toBe(true);
    expect(stderr).not.toContain("llm.openrouter.zdr");
  });
});
