/** `/plugins` toggles: which rows changed, and how each scope grants and applies them. */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  PluginModuleLoader,
  PluginRegistryServiceImpl,
  PluginRuntimeServiceImpl,
  type PluginInspection,
} from "@jazz/adapters/plugins";
import type { TerminalService } from "@jazz/core/interfaces/terminal";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  applyPluginChanges,
  pluginActiveFor,
  pluginChanges,
  pluginStateTag,
} from "./plugin-manager";

const PLUGIN_ID = "com.jazz.test.toggle";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-manager-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function installPlugin(): Promise<{
  readonly registry: PluginRegistryServiceImpl;
  readonly runtime: PluginRuntimeServiceImpl;
  readonly loader: PluginModuleLoader;
}> {
  const source = "export default { apiVersion: 1, register() {} };\n";
  const packageDirectory = path.join(root, "package");
  await fs.mkdir(packageDirectory);
  await fs.writeFile(path.join(packageDirectory, "plugin.mjs"), source);
  await fs.writeFile(
    path.join(packageDirectory, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: PLUGIN_ID,
      name: "Toggle",
      version: "1.0.0",
      hostApi: 1,
      artifact: "./plugin.mjs",
      sha256: createHash("sha256").update(source).digest("hex"),
      hooks: ["route.skills"],
      policyHooks: [],
      decisionProviders: [],
      network: { destinations: [] },
      dataSent: [],
      secrets: [],
    }),
  );
  const registry = new PluginRegistryServiceImpl({ pluginDirectory: path.join(root, "plugins") });
  await registry.add(path.join(packageDirectory, "manifest.json"));
  const loader = new PluginModuleLoader({
    stateStore: registry.stateStore,
    installer: registry.installer,
  });
  const runtime = new PluginRuntimeServiceImpl({ loader, secrets: registry.secrets });
  return { registry, runtime, loader };
}

function scriptedTerminal(answers: readonly boolean[]): {
  readonly terminal: TerminalService;
  readonly asked: string[];
} {
  const asked: string[] = [];
  const queue = [...answers];
  const terminal = {
    isInteractive: true,
    confirm: (message: string) =>
      Effect.sync(() => {
        asked.push(message);
        return queue.shift();
      }),
    warn: () => Effect.void,
    info: () => Effect.void,
    success: () => Effect.void,
    log: () => Effect.void,
  } as unknown as TerminalService;
  return { terminal, asked };
}

function inspectionWith(overrides: Partial<PluginInspection>): PluginInspection {
  return {
    id: PLUGIN_ID,
    trusted: true,
    consented: true,
    enabledAgentIds: [],
    enabledForAllAgents: false,
    ...overrides,
  } as PluginInspection;
}

describe("pluginActiveFor and pluginChanges", () => {
  test("a conversation override wins over the saved enablement", () => {
    const savedOn = inspectionWith({ enabledForAllAgents: true });
    expect(pluginActiveFor(savedOn, "agent", new Map())).toBe(true);
    expect(pluginActiveFor(savedOn, "agent", new Map([[PLUGIN_ID, false]]))).toBe(false);
    expect(pluginStateTag(savedOn, "agent", new Map([[PLUGIN_ID, false]])).tag).toBe(
      "off · temporary",
    );
    expect(
      pluginActiveFor(inspectionWith({ enabledAgentIds: ["other"] }), "agent", new Map()),
    ).toBe(false);
  });

  test("only rows whose checked state differs change, turning off before turning on", () => {
    const on = inspectionWith({ id: "b.on", enabledForAllAgents: true });
    const off = inspectionWith({ id: "a.off" });
    const untouched = inspectionWith({ id: "c.same" });
    const changes = pluginChanges([off, on, untouched], new Set(["a.off"]), "agent", new Map());
    expect(changes.map((change) => [change.inspection.id, change.enable])).toEqual([
      ["b.on", false],
      ["a.off", true],
    ]);
  });
});

describe("applyPluginChanges", () => {
  test("turning on for good asks for trust and consent, then saves it for every agent", async () => {
    const { registry, runtime } = await installPlugin();
    const { terminal, asked } = scriptedTerminal([true, true]);
    const inspection = await registry.inspect(PLUGIN_ID);

    const outcome = await Effect.runPromise(
      applyPluginChanges(
        terminal,
        registry,
        runtime,
        [{ inspection, enable: true }],
        "always",
        "agent",
      ),
    );

    expect(asked).toHaveLength(2);
    expect(outcome.applied).toEqual([{ id: PLUGIN_ID, state: "on for every agent" }]);
    expect((await registry.inspect(PLUGIN_ID)).enabledForAllAgents).toBe(true);
  });

  test("a declined trust prompt leaves the plugin off and grants nothing", async () => {
    const { registry, runtime } = await installPlugin();
    const { terminal } = scriptedTerminal([false]);
    const inspection = await registry.inspect(PLUGIN_ID);

    const outcome = await Effect.runPromise(
      applyPluginChanges(
        terminal,
        registry,
        runtime,
        [{ inspection, enable: true }],
        "always",
        "agent",
      ),
    );

    expect(outcome.declined).toEqual([PLUGIN_ID]);
    const after = await registry.inspect(PLUGIN_ID);
    expect(after.trusted).toBe(false);
    expect(after.enabledForAllAgents).toBe(false);
  });

  test("this-conversation changes run without touching the saved state", async () => {
    const { registry, runtime, loader } = await installPlugin();
    const { terminal } = scriptedTerminal([true, true]);
    const inspection = await registry.inspect(PLUGIN_ID);

    await Effect.runPromise(
      applyPluginChanges(
        terminal,
        registry,
        runtime,
        [{ inspection, enable: true }],
        "conversation",
        "agent",
      ),
    );
    expect((await loader.listEnabledForAgent("agent")).map((entry) => entry.id)).toEqual([
      PLUGIN_ID,
    ]);
    const saved = await registry.inspect(PLUGIN_ID);
    expect(saved.enabledForAllAgents).toBe(false);
    expect(saved.enabledAgentIds).toEqual([]);

    const outcome = await Effect.runPromise(
      applyPluginChanges(
        terminal,
        registry,
        runtime,
        [{ inspection: saved, enable: false }],
        "conversation",
        "agent",
      ),
    );
    expect(outcome.applied).toEqual([{ id: PLUGIN_ID, state: "off for this conversation" }]);
    expect(await loader.listEnabledForAgent("agent")).toEqual([]);
  });

  test("turning off for good clears a conversation override too", async () => {
    const { registry, runtime, loader } = await installPlugin();
    const { terminal } = scriptedTerminal([true, true]);
    const inspection = await registry.inspect(PLUGIN_ID);
    await Effect.runPromise(
      applyPluginChanges(
        terminal,
        registry,
        runtime,
        [{ inspection, enable: true }],
        "conversation",
        "agent",
      ),
    );

    await Effect.runPromise(
      applyPluginChanges(
        terminal,
        registry,
        runtime,
        [{ inspection: await registry.inspect(PLUGIN_ID), enable: false }],
        "always",
        "agent",
      ),
    );

    expect(loader.listConversationOverrides().size).toBe(0);
    expect(await loader.listEnabledForAgent("agent")).toEqual([]);
  });
});
