/** Covers the digest-bound lifecycle from inert install through per-agent runtime sessions. */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentRunMetrics } from "@jazz/core/agent/metrics/agent-run-metrics";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { PluginModuleLoader } from "./module-loader";
import { PluginRegistryServiceImpl } from "./plugin-registry-service";
import { PluginRuntimeServiceImpl } from "./plugin-runtime-service";

async function packageFixture(
  root: string,
  version: string,
  source: string,
): Promise<{ readonly manifestPath: string; readonly digest: string }> {
  const directory = path.join(root, `package-${version}`);
  await fs.mkdir(directory, { recursive: true });
  const digest = createHash("sha256").update(source).digest("hex");
  await fs.writeFile(path.join(directory, "plugin.mjs"), source);
  const manifest = {
    schemaVersion: 1,
    id: "com.jazz.test.lifecycle",
    name: "Lifecycle test",
    version,
    hostApi: 1,
    artifact: "./plugin.mjs",
    sha256: digest,
    hooks: ["route.skills"],
    decisionProviders: [],
    network: { destinations: [] },
    dataSent: [],
    secrets: [],
  };
  const manifestPath = path.join(directory, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  return { manifestPath, digest };
}

describe("PluginRegistryServiceImpl", () => {
  test("requires digest-bound trust and consent before per-agent enablement", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-lifecycle-"));
    const fixture = await packageFixture(
      root,
      "1.0.0",
      "export default { apiVersion: 1, register() {} };\n",
    );
    const registry = new PluginRegistryServiceImpl({ pluginDirectory: path.join(root, "plugins") });
    await registry.add(fixture.manifestPath);

    await expect(registry.enable("com.jazz.test.lifecycle", "default")).rejects.toThrow(
      "not trusted",
    );
    await registry.trust("com.jazz.test.lifecycle", fixture.digest);
    await expect(registry.enable("com.jazz.test.lifecycle", "default")).rejects.toThrow(
      "does not have current egress consent",
    );
    const inspection = await registry.inspect("com.jazz.test.lifecycle");
    await registry.grantConsent("com.jazz.test.lifecycle", inspection.consentDigest);
    await registry.enable("com.jazz.test.lifecycle", "default");

    const enabled = await registry.inspect("com.jazz.test.lifecycle");
    expect(enabled.trusted).toBe(true);
    expect(enabled.consented).toBe(true);
    expect(enabled.enabledAgentIds).toEqual(["default"]);
    expect((await registry.doctor("com.jazz.test.lifecycle")).healthy).toBe(true);

    const freshProcessView = new PluginRegistryServiceImpl({
      pluginDirectory: path.join(root, "plugins"),
    });
    expect(
      (await freshProcessView.disable("com.jazz.test.lifecycle", "default")).restartRequired,
    ).toBe(true);
    expect((await freshProcessView.remove("com.jazz.test.lifecycle")).restartRequired).toBe(true);
  });

  test("updates and rollbacks disabled, preserving digest grants", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-lifecycle-"));
    const first = await packageFixture(
      root,
      "1.0.0",
      "export default { apiVersion: 1, register() {} };\n",
    );
    const second = await packageFixture(
      root,
      "2.0.0",
      "export default { apiVersion: 1, register() { return {}; } };\n",
    );
    const registry = new PluginRegistryServiceImpl({ pluginDirectory: path.join(root, "plugins") });
    await registry.add(first.manifestPath);
    await registry.trust("com.jazz.test.lifecycle", first.digest);
    let inspection = await registry.inspect("com.jazz.test.lifecycle");
    await registry.grantConsent("com.jazz.test.lifecycle", inspection.consentDigest);
    await registry.enable("com.jazz.test.lifecycle", "default");

    await registry.update("com.jazz.test.lifecycle", second.manifestPath);
    inspection = await registry.inspect("com.jazz.test.lifecycle");
    expect(inspection.current.manifest.version).toBe("2.0.0");
    expect(inspection.enabledAgentIds).toEqual([]);
    expect(inspection.trusted).toBe(false);

    await registry.rollback("com.jazz.test.lifecycle");
    inspection = await registry.inspect("com.jazz.test.lifecycle");
    expect(inspection.current.manifest.version).toBe("1.0.0");
    expect(inspection.trusted).toBe(true);
    expect(inspection.consented).toBe(true);
    expect(inspection.enabledAgentIds).toEqual([]);
  });

  test("detects one-handler-per-hook conflicts for the same agent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-lifecycle-"));
    const first = await packageFixture(
      root,
      "1.0.0",
      "export default { apiVersion: 1, register() {} };\n",
    );
    const secondDirectory = path.join(root, "other");
    await fs.mkdir(secondDirectory);
    const secondSource = "export default { apiVersion: 1, register() {} };\n// other";
    const secondDigest = createHash("sha256").update(secondSource).digest("hex");
    await fs.writeFile(path.join(secondDirectory, "plugin.mjs"), secondSource);
    await fs.writeFile(
      path.join(secondDirectory, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "com.jazz.test.other",
        name: "Other",
        version: "1.0.0",
        hostApi: 1,
        artifact: "./plugin.mjs",
        sha256: secondDigest,
        hooks: ["route.skills"],
        decisionProviders: [],
        network: { destinations: [] },
        dataSent: [],
        secrets: [],
      }),
    );
    const registry = new PluginRegistryServiceImpl({ pluginDirectory: path.join(root, "plugins") });
    for (const [manifestPath, digest, id] of [
      [first.manifestPath, first.digest, "com.jazz.test.lifecycle"],
      [path.join(secondDirectory, "manifest.json"), secondDigest, "com.jazz.test.other"],
    ] as const) {
      await registry.add(manifestPath);
      await registry.trust(id, digest);
      await registry.grantConsent(id, (await registry.inspect(id)).consentDigest);
    }
    await registry.enable("com.jazz.test.lifecycle", "default");
    await expect(registry.enable("com.jazz.test.other", "default")).rejects.toThrow(
      "hook conflict",
    );
  });

  test("never imports before grants and creates a fresh registration session per run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-loader-"));
    const importedMarker = path.join(root, "imported.txt");
    const registeredMarker = path.join(root, "registered.txt");
    const source = [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(importedMarker)}, "imported\\n");`,
      "export default { apiVersion: 1, register() {",
      `appendFileSync(${JSON.stringify(registeredMarker)}, "registered\\n");`,
      "}, dispose() {} };",
    ].join("\n");
    const fixture = await packageFixture(root, "1.0.0", source);
    const loaderRef: { current?: PluginModuleLoader } = {};
    const registry = new PluginRegistryServiceImpl({
      pluginDirectory: path.join(root, "plugins"),
      hasLoadedDigest: (digest): boolean => loaderRef.current?.hasLoadedDigest(digest) ?? false,
    });
    const loader = new PluginModuleLoader({
      stateStore: registry.stateStore,
      installer: registry.installer,
    });
    loaderRef.current = loader;
    await registry.add(fixture.manifestPath);
    expect(await loader.loadEnabledForAgent("default")).toEqual([]);
    await expect(fs.stat(importedMarker)).rejects.toThrow();

    await registry.trust("com.jazz.test.lifecycle", fixture.digest);
    await registry.grantConsent(
      "com.jazz.test.lifecycle",
      (await registry.inspect("com.jazz.test.lifecycle")).consentDigest,
    );
    await registry.enable("com.jazz.test.lifecycle", "default");
    expect(await loader.loadEnabledForAgent("default")).toHaveLength(1);
    await expect(fs.stat(registeredMarker)).rejects.toThrow();
    const runtime = new PluginRuntimeServiceImpl({ loader, secrets: registry.secrets });
    const runOptions = { agentId: "default", metrics: {} as AgentRunMetrics };
    const firstSession = await Effect.runPromise(runtime.openSession(runOptions));
    await Effect.runPromise(firstSession.close());
    const secondSession = await Effect.runPromise(runtime.openSession(runOptions));
    await Effect.runPromise(secondSession.close());
    expect((await fs.readFile(importedMarker, "utf8")).trim().split("\n")).toHaveLength(1);
    expect((await fs.readFile(registeredMarker, "utf8")).trim().split("\n")).toHaveLength(2);

    const disabled = await registry.disable("com.jazz.test.lifecycle");
    expect(disabled.restartRequired).toBe(true);
    expect(await loader.loadEnabledForAgent("default")).toEqual([]);
  });

  test("removes state and garbage-collects unreferenced artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-lifecycle-"));
    const fixture = await packageFixture(
      root,
      "1.0.0",
      "export default { apiVersion: 1, register() {} };\n",
    );
    const registry = new PluginRegistryServiceImpl({ pluginDirectory: path.join(root, "plugins") });
    await registry.add(fixture.manifestPath);
    expect(await registry.installer.verify(fixture.digest)).toBe(true);
    await registry.remove("com.jazz.test.lifecycle");
    expect(await registry.installer.verify(fixture.digest)).toBe(false);
    expect(await registry.list()).toEqual([]);
  });

  test("refuses a state-file artifact path that bypasses digest-addressed storage", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-loader-path-"));
    const fixture = await packageFixture(
      root,
      "1.0.0",
      "export default { apiVersion: 1, register() {} };\n",
    );
    const registry = new PluginRegistryServiceImpl({ pluginDirectory: path.join(root, "plugins") });
    await registry.add(fixture.manifestPath);
    await registry.trust("com.jazz.test.lifecycle", fixture.digest);
    await registry.grantConsent(
      "com.jazz.test.lifecycle",
      (await registry.inspect("com.jazz.test.lifecycle")).consentDigest,
    );
    await registry.enable("com.jazz.test.lifecycle", "default");
    await registry.stateStore.transact((state) => {
      const current = state.plugins["com.jazz.test.lifecycle"]!;
      return {
        state: {
          ...state,
          plugins: {
            ...state.plugins,
            "com.jazz.test.lifecycle": {
              ...current,
              current: { ...current.current, artifactPath: fixture.manifestPath },
            },
          },
        },
        result: undefined,
      };
    });
    const loader = new PluginModuleLoader({
      stateStore: registry.stateStore,
      installer: registry.installer,
    });
    await expect(loader.loadEnabledForAgent("default")).rejects.toThrow("digest-addressed");
  });
});
