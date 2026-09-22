/** Focused tests for strict, dependency-inlined plugin packaging. */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { probePackedPlugin } from "@jazz/adapters/plugins";
import { describe, expect, it } from "bun:test";
import { packPlugin } from "./plugin-pack";

const fixture = path.join(import.meta.dir, "fixtures", "plugin-pack", "good");

describe("packPlugin", () => {
  it("emits a validated single-file artifact, digest, and catalog entry", async () => {
    const releaseDirectory = mkdtempSync(path.join(tmpdir(), "jazz-plugin-pack-"));
    const packed = await packPlugin({ pluginDirectory: fixture, releaseDirectory });
    const artifact = readFileSync(packed.artifactPath, "utf8");
    const catalog = JSON.parse(readFileSync(packed.catalogEntryPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(artifact).toContain("bundled");
    expect(artifact).not.toContain('from "zod"');
    expect(readFileSync(packed.digestPath, "utf8")).toBe(`${packed.sha256}  plugin.mjs\n`);
    expect(catalog["artifact"]).toBe("./plugin.mjs");
    expect(catalog["sha256"]).toBe(packed.sha256);
    const second = await packPlugin({
      pluginDirectory: fixture,
      releaseDirectory: mkdtempSync(path.join(tmpdir(), "jazz-plugin-pack-repeat-")),
    });
    expect(second.sha256).toBe(packed.sha256);
    const probe = await probePackedPlugin({
      manifestPath: packed.catalogEntryPath,
      routeSkillsInput: {
        requestText: "Use the bundled fixture",
        skills: [{ name: "fixture", description: "Bundled dependency probe" }],
      },
    });
    expect(probe.routeSkillsOutcome?.status).toBe("answered");
  });

  it("rejects an opaque dynamic import", async () => {
    const pluginDirectory = mkdtempSync(path.join(tmpdir(), "jazz-plugin-opaque-"));
    mkdirSync(path.join(pluginDirectory, "src"));
    writeFileSync(
      path.join(pluginDirectory, "jazz-plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "com.jazz.tests.opaque",
        name: "Opaque fixture",
        version: "0.0.1",
        hostApi: 1,
        entry: "src/index.ts",
        hooks: [],
        policyHooks: [],
        decisionProviders: [],
        network: { destinations: [] },
        dataSent: [],
        secrets: [],
      }),
    );
    writeFileSync(
      path.join(pluginDirectory, "src", "index.ts"),
      'const target = process.env["PLUGIN_IMPORT"]; if (target) await import(target); export default { apiVersion: 1, register() {} };',
    );
    await expect(
      packPlugin({
        pluginDirectory,
        releaseDirectory: mkdtempSync(path.join(tmpdir(), "jazz-plugin-release-")),
      }),
    ).rejects.toThrow();
  });

  it("rejects native or separately emitted asset inputs", async () => {
    const pluginDirectory = mkdtempSync(path.join(tmpdir(), "jazz-plugin-native-"));
    mkdirSync(path.join(pluginDirectory, "src"));
    writeFileSync(
      path.join(pluginDirectory, "jazz-plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "com.jazz.tests.native",
        name: "Native fixture",
        version: "0.0.1",
        hostApi: 1,
        entry: "src/index.ts",
        hooks: [],
        policyHooks: [],
        decisionProviders: [],
        network: { destinations: [] },
        dataSent: [],
        secrets: [],
      }),
    );
    writeFileSync(
      path.join(pluginDirectory, "src", "module.wasm"),
      new Uint8Array([0, 97, 115, 109]),
    );
    writeFileSync(
      path.join(pluginDirectory, "src", "index.ts"),
      'import modulePath from "./module.wasm"; void modulePath; export default { apiVersion: 1, register() {} };',
    );
    await expect(
      packPlugin({
        pluginDirectory,
        releaseDirectory: mkdtempSync(path.join(tmpdir(), "jazz-plugin-release-")),
      }),
    ).rejects.toThrow(/one entry-point artifact|unsupported input/);
  });
});
