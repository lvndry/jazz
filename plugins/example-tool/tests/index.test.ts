/** Exercises the example plugin at its public boundary with a fake host. */

import type {
  JazzPluginModule,
  PluginCommandRegistration,
  PluginHostApi,
  PluginLifecycleRegistration,
  PluginToolRegistration,
} from "@jazz/plugin-sdk";
import { describe, expect, it } from "bun:test";
import plugin from "../src/index";

function fakeHost(): {
  readonly api: PluginHostApi;
  readonly tools: Map<string, PluginToolRegistration>;
  readonly commands: Map<string, PluginCommandRegistration>;
  readonly lifecycle: Map<string, PluginLifecycleRegistration>;
} {
  const tools = new Map<string, PluginToolRegistration>();
  const commands = new Map<string, PluginCommandRegistration>();
  const lifecycle = new Map<string, PluginLifecycleRegistration>();
  const api: PluginHostApi = {
    apiVersion: 1,
    hooks: { register: () => {} },
    decisions: {
      registerProvider: () => {
        throw new Error("not used");
      },
    },
    tools: {
      register: (registration) => {
        tools.set(registration.name, registration);
      },
    },
    commands: {
      register: (registration) => {
        commands.set(registration.name, registration);
      },
    },
    lifecycle: {
      register: (registration) => {
        lifecycle.set(registration.event, registration);
      },
    },
    secrets: { get: async () => undefined },
  };
  return { api, tools, commands, lifecycle };
}

function register(module: JazzPluginModule = plugin) {
  const host = fakeHost();
  module.register(host.api);
  return host;
}

describe("example-tool plugin", () => {
  it("registers the reverse_text tool", () => {
    const host = register();
    expect([...host.tools.keys()]).toEqual(["reverse_text"]);
  });

  it("reverses the given text", async () => {
    const host = register();
    const result = await host.tools
      .get("reverse_text")!
      .handler({ text: "hello" }, { signal: new AbortController().signal });
    expect(result).toEqual({ content: "olleh" });
  });

  it("tolerates a missing text argument", async () => {
    const host = register();
    const result = await host.tools
      .get("reverse_text")!
      .handler({}, { signal: new AbortController().signal });
    expect(result).toEqual({ content: "" });
  });

  it("subscribes to the run-complete lifecycle event", async () => {
    const host = register();
    expect([...host.lifecycle.keys()]).toEqual(["run-complete"]);
    await expect(
      host.lifecycle.get("run-complete")!.handler(
        {
          event: "run-complete",
          agentId: "a",
          conversationId: "c",
          data: { summary: "done" },
        },
        { signal: new AbortController().signal },
      ),
    ).resolves.toBeUndefined();
  });

  it("registers the greet command and builds a message from its args", async () => {
    const host = register();
    expect([...host.commands.keys()]).toEqual(["greet"]);
    const withName = await host.commands
      .get("greet")!
      .handler({ args: ["Ada", "Lovelace"] }, { signal: new AbortController().signal });
    expect(withName).toEqual({ message: "Greet Ada Lovelace warmly." });
    const noName = await host.commands
      .get("greet")!
      .handler({ args: [] }, { signal: new AbortController().signal });
    expect(noName).toEqual({ message: "Greet the user warmly." });
  });
});
