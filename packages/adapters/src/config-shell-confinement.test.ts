/**
 * `shell.confinement` from a project config: a cloned repository may turn write confinement on,
 * but never off.
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

let originalJazzHome: string | undefined;
let originalCwd: string;

beforeEach(() => {
  originalJazzHome = process.env["JAZZ_HOME"];
  originalCwd = process.cwd();
  process.env["JAZZ_HOME"] = mkdtempSync(path.join(tmpdir(), "jazz-confinement-home-"));
  process.chdir(mkdtempSync(path.join(tmpdir(), "jazz-confinement-project-")));
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalJazzHome === undefined) {
    delete process.env["JAZZ_HOME"];
  } else {
    process.env["JAZZ_HOME"] = originalJazzHome;
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

function loadConfinement() {
  const layer = createConfigLayer().pipe(Layer.provide(NodeFileSystem.layer));
  return Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* AgentConfigServiceTag;
      return (yield* config.appConfig).shell?.confinement;
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

describe("shell.confinement in a project config", () => {
  it("cannot turn off a global on, and says why", async () => {
    writeGlobalConfig({ shell: { confinement: "on" } });
    writeProjectConfig({ shell: { confinement: "off" } });

    const { result, stderr } = await quietly(() => loadConfinement());

    expect(result).toBe("on");
    expect(stderr).toContain('ignoring shell.confinement: "off"');
  });

  it("cannot turn off an unset global, so the unattended default stays on", async () => {
    writeGlobalConfig({});
    writeProjectConfig({ shell: { confinement: "off" } });

    const { result } = await quietly(() => loadConfinement());

    expect(result).toBeUndefined();
  });

  it("can turn it on when the global config leaves it unset", async () => {
    writeGlobalConfig({});
    writeProjectConfig({ shell: { confinement: "on" } });

    const { result, stderr } = await quietly(() => loadConfinement());

    expect(result).toBe("on");
    expect(stderr).not.toContain("shell.confinement");
  });

  it("lets the global config turn it off", async () => {
    writeGlobalConfig({ shell: { confinement: "off" } });

    const { result } = await quietly(() => loadConfinement());

    expect(result).toBe("off");
  });
});
