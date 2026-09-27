import { AgentServiceTag, type AgentService } from "@jazz/core/interfaces/agent-service";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { pluginEnableCommand, pluginTrustCommand } from "./plugin";

const headlessTerminal = {
  isInteractive: false,
  confirm: () => Effect.succeed(true),
} as unknown as TerminalService;

const layer = Layer.mergeAll(
  Layer.succeed(TerminalServiceTag, headlessTerminal),
  Layer.succeed(AgentServiceTag, {} as AgentService),
);

describe("plugin trust and consent without a terminal", () => {
  it("refuses trust headlessly even with --yes", async () => {
    const error = await Effect.runPromise(
      pluginTrustCommand("com.example.plugin", { yes: true }).pipe(
        Effect.flip,
        Effect.provide(layer),
      ),
    );
    expect(error.message).toContain("Plugin trust requires a local interactive terminal");
  });

  it("refuses egress consent headlessly even with --yes", async () => {
    const error = await Effect.runPromise(
      pluginEnableCommand("com.example.plugin", undefined, { yes: true }).pipe(
        Effect.flip,
        Effect.provide(layer),
      ),
    );
    expect(error.message).toContain("Plugin egress consent requires a local interactive terminal");
  });
});
