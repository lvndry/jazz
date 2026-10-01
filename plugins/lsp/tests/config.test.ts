/**
 * Configuration loading tests. The per-extension language-ID map is the load-bearing
 * contract: a `.tsx` file must open as `typescriptreact`, and a legacy config that puts a
 * single `languageId` beside a mixed `extensions` list (the shape that once made tsserver
 * parse JSX as plain TypeScript) is rejected instead of silently mis-sent.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { loadServers, selectServer } from "../src/config";

const temp = await mkdtemp(join(tmpdir(), "jazz-lsp-config-"));
const configPath = join(temp, "lsp.json");
process.env["JAZZ_LSP_CONFIG"] = configPath;

const reactEntry = {
  id: "typescript",
  command: "typescript-language-server",
  args: ["--stdio"],
  extensions: { ".ts": "typescript", ".tsx": "typescriptreact" },
  rootMarkers: ["tsconfig.json", "package.json"],
};

async function writeConfig(servers: unknown[]): Promise<void> {
  await writeFile(configPath, JSON.stringify({ servers }));
}

async function loadError(): Promise<string> {
  try {
    await loadServers();
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  return "";
}

afterAll(async () => {
  delete process.env["JAZZ_LSP_CONFIG"];
  await rm(temp, { recursive: true, force: true });
});

describe("loadServers", () => {
  it("accepts the per-extension language-ID map", async () => {
    await writeConfig([reactEntry]);
    const servers = await loadServers();
    expect(servers).toHaveLength(1);
    const server = servers[0];
    if (server === undefined) throw new Error("expected one server");
    expect(server.extensions[".tsx"]).toBe("typescriptreact");
    expect(server.extensions[".ts"]).toBe("typescript");
  });

  it("rejects a legacy top-level languageId with the fix in the message", async () => {
    await writeConfig([
      {
        id: "typescript",
        command: "typescript-language-server",
        args: ["--stdio"],
        extensions: { ".ts": "typescript" },
        languageId: "typescript",
        rootMarkers: ["tsconfig.json"],
      },
    ]);
    expect(await loadError()).toMatch(/top-level languageId is unsupported/);
  });

  it("rejects a mixed extensions list, the shape that mis-parses JSX", async () => {
    await writeConfig([
      {
        id: "typescript",
        command: "typescript-language-server",
        args: ["--stdio"],
        extensions: [".ts", ".tsx"],
        languageId: "typescript",
        rootMarkers: ["tsconfig.json"],
      },
    ]);
    expect(await loadError()).toMatch(/top-level languageId is unsupported/);
  });

  it("rejects an extension that maps to an empty language ID", async () => {
    await writeConfig([
      {
        id: "typescript",
        command: "typescript-language-server",
        args: ["--stdio"],
        extensions: { ".ts": "" },
        rootMarkers: ["tsconfig.json"],
      },
    ]);
    expect(await loadError()).toMatch(/must map to a non-empty language ID/);
  });
});

describe("selectServer", () => {
  it("opens each dialect under its own language ID", async () => {
    await writeConfig([reactEntry]);
    for (const name of ["sample.ts", "Sample.tsx"]) await writeFile(join(temp, name), "");
    const ts = await selectServer(join(temp, "sample.ts"), temp);
    const tsx = await selectServer(join(temp, "Sample.tsx"), temp);
    expect(ts.languageId).toBe("typescript");
    expect(tsx.languageId).toBe("typescriptreact");
  });

  it("falls through to a later entry when only it names the extension", async () => {
    const javascript = {
      ...reactEntry,
      id: "javascript",
      extensions: { ".js": "javascript" },
    };
    await writeFile(join(temp, "sample.js"), "");
    await writeConfig([reactEntry, javascript]);
    const js = await selectServer(join(temp, "sample.js"), temp);
    expect(js.config.id).toBe("javascript");
    expect(js.languageId).toBe("javascript");
  });
});
