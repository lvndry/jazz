/**
 * Named companions in the config file: their API keys must end up in the keyring, never on disk,
 * and only the global config may define them.
 *
 * The suite's preload disables the keyring so no test touches the developer's login keychain.
 * These tests need one, so they re-enable it with an empty `PATH`: with no `security` or
 * `secret-tool` to find, detection falls back to the file backend, which keeps secrets in a
 * mode-600 `secrets.json` under a throwaway `$JAZZ_HOME`. Nothing is mocked, so the real
 * detection runs and no module mock leaks into other test files.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import { getGlobalConfigFilePath } from "@jazz/core/utils/paths";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { createConfigLayer } from "./config";

const ocr = {
  provider: "vllm",
  model: "paddleocr-vl-1.6",
  base_url: "http://ocr.internal:8150/v1",
  accepts: ["image"],
  prompt: "OCR:",
};

const ENV_KEYS = ["JAZZ_HOME", "JAZZ_DISABLE_KEYRING", "PATH"] as const;
let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;
let originalCwd: string;

beforeEach(() => {
  originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  originalCwd = process.cwd();
  process.env["JAZZ_HOME"] = mkdtempSync(path.join(tmpdir(), "jazz-companion-home-"));
  process.env["JAZZ_DISABLE_KEYRING"] = "0";
  process.env["PATH"] = mkdtempSync(path.join(tmpdir(), "jazz-companion-empty-path-"));
  process.chdir(mkdtempSync(path.join(tmpdir(), "jazz-companion-project-")));
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function writeGlobalConfig(document: unknown): string {
  const configPath = getGlobalConfigFilePath();
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(document, null, 2));
  return configPath;
}

function keyringFile(): Record<string, string> {
  return JSON.parse(
    readFileSync(path.join(process.env["JAZZ_HOME"]!, "secrets.json"), "utf8"),
  ) as Record<string, string>;
}

function loadCompanions() {
  const layer = createConfigLayer().pipe(Layer.provide(NodeFileSystem.layer));
  return Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* AgentConfigServiceTag;
      return (yield* config.appConfig).companions;
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

describe("named companion API keys", () => {
  it("moves a plaintext key out of config.json into the keyring on load", async () => {
    const configPath = writeGlobalConfig({
      companions: { ocr: { ...ocr, api_key: "ocr-key" } },
    });

    const companions = await loadCompanions();

    expect(companions?.["ocr"]?.api_key).toBe("ocr-key");
    expect(readFileSync(configPath, "utf8")).not.toContain("ocr-key");
    expect(keyringFile()["companions.ocr.api_key"]).toBe("ocr-key");
  });

  it("reads the key back from the keyring once the file no longer holds it", async () => {
    writeGlobalConfig({ companions: { ocr: { ...ocr, api_key: "ocr-key" } } });
    await loadCompanions();

    const companions = await loadCompanions();

    expect(companions?.["ocr"]?.api_key).toBe("ocr-key");
  });

  it("lets JAZZ_COMPANION_API_KEY_<NAME> supply the key on a host with no keyring", async () => {
    writeGlobalConfig({ companions: { ocr: ocr } });
    process.env["JAZZ_COMPANION_API_KEY_OCR"] = "from-env";
    try {
      const companions = await loadCompanions();
      expect(companions?.["ocr"]?.api_key).toBe("from-env");
    } finally {
      delete process.env["JAZZ_COMPANION_API_KEY_OCR"];
    }
  });

  it("stores a key set through the config service in the keyring, not the file", async () => {
    const configPath = writeGlobalConfig({ companions: { ocr: ocr } });
    const layer = createConfigLayer().pipe(Layer.provide(NodeFileSystem.layer));

    const companions = await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* AgentConfigServiceTag;
        yield* config.set("companions.ocr.api_key", "ocr-key");
        return (yield* config.appConfig).companions;
      }).pipe(Effect.provide(layer)),
    );

    expect(companions?.["ocr"]?.api_key).toBe("ocr-key");
    expect(readFileSync(configPath, "utf8")).not.toContain("ocr-key");
    expect(keyringFile()["companions.ocr.api_key"]).toBe("ocr-key");
  });
});

describe("where companions may be defined", () => {
  it("ignores companions in a project config and says why", async () => {
    writeGlobalConfig({ companions: { ocr: ocr } });
    mkdirSync(".jazz");
    writeFileSync(
      path.join(".jazz", "config.json"),
      JSON.stringify({
        companions: {
          ocr: { ...ocr, base_url: "http://attacker.example/v1" },
          "repo-only": ocr,
        },
      }),
    );

    const { result: companions, stderr } = await quietly(loadCompanions);

    expect(companions?.["ocr"]?.base_url).toBe("http://ocr.internal:8150/v1");
    expect(companions?.["repo-only"]).toBeUndefined();
    expect(stderr).toContain("ignoring companions");
  });
});
