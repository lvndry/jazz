/**
 * Integration tests use a framed fake language server so the same plugin
 * registration, process transport, and approved WorkspaceEdit path execute.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  JazzPluginModule,
  PluginToolRegistration,
  WorkspaceContextHandler,
} from "@jazz/plugin-sdk";
import { afterAll, describe, expect, it } from "bun:test";
import plugin from "../src";
import { ambientDiagnostics, document } from "../src/client";
import { selectServer } from "../src/config";

const temp = await mkdtemp(join(tmpdir(), "jazz-lsp-test-"));
const file = join(temp, "sample.ts");
await writeFile(file, "foo = 1;\n");
await writeFile(join(temp, "package.json"), "{}");
const config = join(temp, "lsp.json");
const started = join(temp, "server-started");
await writeFile(
  config,
  JSON.stringify({
    servers: [
      {
        id: "fake",
        command: process.execPath,
        args: [join(import.meta.dir, "fake-server.ts"), file, started],
        extensions: [".ts"],
        languageId: "typescript",
        rootMarkers: ["package.json"],
      },
    ],
  }),
);
process.env["JAZZ_LSP_CONFIG"] = config;

const registrations = new Map<string, PluginToolRegistration>();
let workspace: WorkspaceContextHandler | undefined;
(plugin as JazzPluginModule).register({
  apiVersion: 1,
  workspace: {
    register: (handler) => {
      workspace = handler;
    },
  },
  tools: {
    register(registration) {
      registrations.set(registration.name, registration);
    },
  },
  hooks: { register() {} },
  policy: { register() {} },
  decisions: {
    registerProvider() {
      throw new Error("unused");
    },
  },
  commands: { register() {} },
  lifecycle: { register() {} },
  secrets: { get: async () => undefined },
});

const context = { signal: new AbortController().signal, cwd: temp };
afterAll(async () => {
  delete process.env["JAZZ_LSP_CONFIG"];
  await rm(temp, { recursive: true, force: true });
});

describe("LSP plugin", () => {
  it("starts a matching server before a tool call and keeps file diagnostics current", async () => {
    expect(await workspace!({ cwd: temp, files: [] }, { signal: context.signal })).toBeUndefined();
    expect(await readFile(started, "utf8")).toBe("started");
    const initial = await workspace!(
      { cwd: temp, files: [{ path: file, kind: "read" }] },
      { signal: context.signal },
    );
    expect(initial?.content).toContain("fake warning");
    await writeFile(file, "foo = 2;\n");
    const updated = await workspace!({ cwd: temp, files: [] }, { signal: context.signal });
    expect(updated?.content).toContain("changed warning: foo = 2;");
    expect(updated?.content).not.toContain("stale warning");
    await writeFile(file, "foo = 1;\n");
  });

  it("returns diagnostics and hover from a generic configured server", async () => {
    const diagnostics = await registrations.get("diagnostics")!.handler({ file }, context);
    expect(diagnostics.isError).toBeUndefined();
    expect(diagnostics.content).toContain("warning");
    const hover = await registrations
      .get("hover")!
      .handler({ file, line: 1, character: 1 }, context);
    expect(hover.content).toContain("Fake symbol");
  });

  it("prepares a multi-step rename and rejects a stale approved edit", async () => {
    const tool = registrations.get("rename_symbol")!;
    const args = { file, line: 1, character: 1, newName: "bar" };
    const proposal = await tool.prepare!(args, context);
    expect(proposal.previewDiff).toContain("+bar");
    await writeFile(file, "foo = 2;\n");
    const stale = await tool.executePrepared!(args, proposal.prepared, context);
    expect(stale.isError).toBe(true);
    expect(stale.content).toContain("Stale LSP edit");
    expect(await readFile(file, "utf8")).toBe("foo = 2;\n");
    await writeFile(file, "foo = 1;\n");
    const fresh = await tool.executePrepared!(args, proposal.prepared, context);
    expect(fresh.isError).toBeUndefined();
    expect(await readFile(file, "utf8")).toBe("bar = 1;\n");
  });

  it("resolves a lazy code action before presenting its diff", async () => {
    await writeFile(file, "foo = 1;\n");
    const args = {
      file,
      startLine: 1,
      startCharacter: 1,
      endLine: 1,
      endCharacter: 4,
      title: "Lazy fix foo",
    };
    const actions = await registrations.get("code_actions")!.handler(args, context);
    expect(actions.content).toContain("Lazy fix foo");
    const prepared = await registrations.get("apply_code_action")!.prepare!(args, context);
    expect(prepared.previewDiff).toContain("+bar");
  });

  it("uses an incremental change for servers requesting incremental sync", async () => {
    const root = join(temp, "incremental");
    await mkdir(root);
    const source = join(root, "sample.ts");
    await writeFile(source, "foo = 1;\n");
    await writeFile(join(root, "package.json"), "{}");
    const incrementalConfig = join(root, "lsp.json");
    await writeFile(
      incrementalConfig,
      JSON.stringify({
        servers: [
          {
            id: "incremental",
            command: process.execPath,
            args: [join(import.meta.dir, "fake-server.ts"), source, join(root, "started"), "2"],
            extensions: [".ts"],
            languageId: "typescript",
            rootMarkers: ["package.json"],
          },
        ],
      }),
    );
    process.env["JAZZ_LSP_CONFIG"] = incrementalConfig;
    try {
      const selected = await selectServer(source, root);
      const opened = await document(selected, context.signal);
      await writeFile(source, "foo = 2;\n");
      const diagnostics = await ambientDiagnostics(selected, context.signal);
      expect(JSON.stringify(diagnostics)).toContain("changed warning: foo = 2;");
      expect(JSON.stringify(diagnostics)).not.toContain("missing incremental range");
      await opened.server.transport.close();
    } finally {
      process.env["JAZZ_LSP_CONFIG"] = config;
    }
  });

  it("reports a configured server startup failure without failing the workspace callback", async () => {
    const brokenConfig = join(temp, "broken-lsp.json");
    await writeFile(
      brokenConfig,
      JSON.stringify({
        servers: [
          {
            id: "broken",
            command: join(temp, "missing-language-server"),
            args: [],
            extensions: [".ts"],
            languageId: "typescript",
            rootMarkers: ["package.json"],
          },
        ],
      }),
    );
    process.env["JAZZ_LSP_CONFIG"] = brokenConfig;
    try {
      const output = await workspace!({ cwd: temp, files: [] }, { signal: context.signal });
      expect(output?.content).toContain("LSP unavailable");
    } finally {
      process.env["JAZZ_LSP_CONFIG"] = config;
    }
  });
});
