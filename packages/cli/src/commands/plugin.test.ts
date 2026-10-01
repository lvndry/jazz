/**
 * Headless trust and consent: `--yes` is itself the operator's consent, so it must work
 * without a TTY; without it the command still demands a local interactive terminal, because
 * a headless run cannot show the confirm prompt.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginRegistryServiceImpl } from "@jazz/adapters/plugins";
import { AgentServiceTag, type AgentService } from "@jazz/core/interfaces/agent-service";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import { beforeAll, afterAll, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { pluginEnableCommand, pluginTrustCommand } from "./plugin";
const headlessTerminal = {
  isInteractive: false,
  confirm: () => Effect.succeed(true),
  heading: () => Effect.void,
  log: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  success: () => Effect.void,
} as unknown as TerminalService;

const layer = Layer.mergeAll(
  Layer.succeed(TerminalServiceTag, headlessTerminal),
  Layer.succeed(AgentServiceTag, {} as AgentService),
);

const pluginId = "com.jazz.test.headless-consent";
let root: string;
let previousHome: string | undefined;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-plugin-headless-"));
  previousHome = process.env["JAZZ_HOME"];
  process.env["JAZZ_HOME"] = root;
  // Install one untrusted fixture plugin that both commands can act on headlessly.
  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });
  await fs.writeFile(
    path.join(repo, "jazz-plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: pluginId,
      name: "Headless consent test",
      version: "0.1.0",
      hostApi: 1,
      entry: "index.ts",
      hooks: [],
      decisionProviders: [],
      tools: [],
      commands: [],
      personas: [],
      skills: [],
      lifecycleHooks: [],
      network: { destinations: [] },
      dataSent: [],
      secrets: [],
    }),
  );
  await fs.writeFile(
    path.join(repo, "index.ts"),
    "export default { apiVersion: 1, register() {} };\n",
  );
  const registry = new PluginRegistryServiceImpl({ pluginDirectory: path.join(root, "plugins") });
  await registry.addFromSource({ localDirectory: repo });
});

afterAll(async () => {
  if (previousHome === undefined) delete process.env["JAZZ_HOME"];
  else process.env["JAZZ_HOME"] = previousHome;
  await fs.rm(root, { recursive: true, force: true });
});

describe("plugin trust and consent without a terminal", () => {
  it("refuses trust headlessly without --yes", async () => {
    const error = await Effect.runPromise(
      pluginTrustCommand(pluginId).pipe(Effect.flip, Effect.provide(layer)),
    );
    expect(error.message).toContain("Plugin trust requires a local interactive terminal");
  });

  it("trusts headlessly with --yes", async () => {
    await Effect.runPromise(
      pluginTrustCommand(pluginId, { yes: true }).pipe(Effect.provide(layer)),
    );
    const registry = new PluginRegistryServiceImpl({ pluginDirectory: path.join(root, "plugins") });
    expect((await registry.inspect(pluginId)).trusted).toBe(true);
  });

  it("refuses egress consent headlessly without --yes", async () => {
    const error = await Effect.runPromise(
      pluginEnableCommand(pluginId, undefined).pipe(Effect.flip, Effect.provide(layer)),
    );
    expect(error.message).toContain("Plugin egress consent requires a local interactive terminal");
  });

  it("grants egress consent headlessly with --yes", async () => {
    await Effect.runPromise(
      pluginEnableCommand(pluginId, undefined, { yes: true }).pipe(Effect.provide(layer)),
    );
    const registry = new PluginRegistryServiceImpl({ pluginDirectory: path.join(root, "plugins") });
    expect((await registry.inspect(pluginId)).enabledForAllAgents).toBe(true);
  });
});
