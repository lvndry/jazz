/** Verifies plugin state serialization, atomic concurrency, and fail-closed recovery behavior. */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { computePluginConsentDigest } from "@jazz/core/agent/plugins/consent";
import { describe, expect, test } from "bun:test";
import { PluginStateError, PluginStateStore } from "./state-store";

/** An installed manifest from before optional capability collections were persisted. */
function storedPlugin(manifestOverrides: Readonly<Record<string, unknown>> = {}) {
  const manifest = {
    schemaVersion: 1,
    id: "com.jazz.test.state",
    name: "State test",
    version: "1.0.0",
    hostApi: 1,
    artifact: "plugin.mjs",
    sha256: "a".repeat(64),
    hooks: [],
    decisionProviders: [],
    network: { destinations: [] },
    dataSent: [],
    secrets: [],
    ...manifestOverrides,
  };
  const lock = {
    manifest,
    source: "fixture",
    artifactPath: "/fixture/plugin.mjs",
    installedAt: "2026-01-01T00:00:00Z",
  };
  return {
    current: lock,
    previous: lock,
    trustedDigests: [manifest.sha256],
    consentGrants: [{ digest: "b".repeat(64), grantedAt: lock.installedAt }],
    enabledAgentIds: ["default"],
    enabledForAllAgents: true,
    activatedDigests: [manifest.sha256],
    storedSecretNames: ["apiKey"],
  };
}

describe("PluginStateStore", () => {
  test("normalizes saved manifests without rewriting state or granting consent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-state-"));
    try {
      const store = new PluginStateStore({ pluginDirectory: root });
      const plugin = storedPlugin();
      const original = JSON.stringify({
        schemaVersion: 1,
        revision: 3,
        plugins: { "com.jazz.test.state": plugin },
      });
      await fs.writeFile(store.statePath, original);
      const loaded = (await store.read()).plugins["com.jazz.test.state"]!;
      for (const lock of [loaded.current, loaded.previous!]) {
        expect(lock.manifest.tools).toEqual([]);
        expect(lock.manifest.policyHooks).toEqual([]);
        expect(() => computePluginConsentDigest(lock.manifest)).not.toThrow();
      }
      expect(loaded).toMatchObject({ ...plugin, current: {}, previous: {} });
      expect(
        loaded.consentGrants.some(
          ({ digest }) => digest === computePluginConsentDigest(loaded.current.manifest),
        ),
      ).toBe(false);
      expect(await fs.readFile(store.statePath, "utf8")).toBe(original);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  for (const slot of ["current", "previous"] as const) {
    for (const invalid of [
      { tools: null },
      { tools: [{}] },
      { sha256: "invalid" },
      { id: "com.jazz.other" },
    ]) {
      test(`rejects invalid ${slot} manifest ${JSON.stringify(invalid)} without changing state`, async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-state-"));
        try {
          const store = new PluginStateStore({ pluginDirectory: root });
          const plugin = storedPlugin();
          const original = JSON.stringify({
            schemaVersion: 1,
            revision: 3,
            plugins: {
              "com.jazz.test.state": { ...plugin, [slot]: storedPlugin(invalid)[slot] },
            },
          });
          await fs.writeFile(store.statePath, original);
          await expect(store.read()).rejects.toMatchObject({ code: "corrupt" });
          await expect(
            store.transact((state) => ({ state, result: undefined })),
          ).rejects.toMatchObject({ code: "corrupt" });
          expect(await fs.readFile(store.statePath, "utf8")).toBe(original);
        } finally {
          await fs.rm(root, { recursive: true, force: true });
        }
      });
    }
  }

  test("serializes concurrent read-modify-write transactions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-state-"));
    const store = new PluginStateStore({ pluginDirectory: root });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.transact((state) => ({
          state: { ...state, revision: state.revision, plugins: state.plugins },
          result: index,
        })),
      ),
    );
    expect((await store.read()).revision).toBe(12);
    expect((await fs.stat(store.statePath)).mode & 0o777).toBe(0o600);
  });

  test("fails closed and preserves incompatible state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-state-"));
    const store = new PluginStateStore({ pluginDirectory: root });
    await fs.mkdir(root, { recursive: true });
    const original = '{"schemaVersion":99,"revision":1,"plugins":{}}\n';
    await fs.writeFile(store.statePath, original);
    await expect(store.read()).rejects.toBeInstanceOf(PluginStateError);
    expect(await fs.readFile(store.statePath, "utf8")).toBe(original);
  });

  test("fails closed on corrupt JSON instead of resetting it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-state-"));
    const store = new PluginStateStore({ pluginDirectory: root });
    await fs.writeFile(store.statePath, "not-json");
    await expect(store.read()).rejects.toMatchObject({ code: "corrupt" });
    expect(await fs.readFile(store.statePath, "utf8")).toBe("not-json");
  });
});
