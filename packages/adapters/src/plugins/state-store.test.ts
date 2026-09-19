/** Verifies plugin state serialization, atomic concurrency, and fail-closed recovery behavior. */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { PluginStateError, PluginStateStore } from "./state-store";

describe("PluginStateStore", () => {
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
