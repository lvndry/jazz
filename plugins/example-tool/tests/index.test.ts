/** Exercises the example plugin at its public boundary with a fake host. */

import type { JazzPluginModule, PluginHostApi, PluginToolRegistration } from "@jazz/plugin-sdk";
import { describe, expect, it } from "bun:test";
import plugin from "../src/index";

function fakeHost(): {
  readonly api: PluginHostApi;
  readonly tools: Map<string, PluginToolRegistration>;
} {
  const tools = new Map<string, PluginToolRegistration>();
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
    secrets: { get: async () => undefined },
  };
  return { api, tools };
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
});
