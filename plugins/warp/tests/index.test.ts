/** Exercises the Warp plugin's pure notification logic and its lifecycle wiring. */

import type {
  JazzPluginModule,
  LifecycleEvent,
  PluginHostApi,
  PluginLifecycleRegistration,
} from "@jazz/plugin-sdk";
import { describe, expect, it } from "bun:test";
import plugin, { notificationFor } from "../src/index";

function event(overrides: Partial<LifecycleEvent> & Pick<LifecycleEvent, "event">): LifecycleEvent {
  return { agentId: "a", conversationId: "c", ...overrides };
}

function register(): Map<string, PluginLifecycleRegistration> {
  const lifecycle = new Map<string, PluginLifecycleRegistration>();
  const api = {
    apiVersion: 1,
    hooks: { register: () => {} },
    decisions: {
      registerProvider: () => {
        throw new Error("not used");
      },
    },
    tools: { register: () => {} },
    commands: { register: () => {} },
    lifecycle: {
      register: (registration: PluginLifecycleRegistration) => {
        lifecycle.set(registration.event, registration);
      },
    },
    secrets: { get: async () => undefined },
  } as unknown as PluginHostApi;
  (plugin as JazzPluginModule).register(api);
  return lifecycle;
}

describe("Warp plugin", () => {
  it("builds a task-complete notification from the run summary", () => {
    const notification = notificationFor(
      event({ event: "run-complete", data: { summary: "  Shipped the fix.  " } }),
    );
    expect(notification).toEqual({ title: "Jazz — task complete", body: "Shipped the fix." });
  });

  it("falls back to a default body when there is no summary", () => {
    const notification = notificationFor(event({ event: "run-complete" }));
    expect(notification?.body).toBe("The agent finished the task.");
  });

  it("announces awaiting-input", () => {
    const notification = notificationFor(event({ event: "awaiting-input" }));
    expect(notification?.title).toBe("Jazz — waiting for you");
  });

  it("does not announce session-start", () => {
    expect(notificationFor(event({ event: "session-start" }))).toBeUndefined();
  });

  it("subscribes to run-complete and awaiting-input, and handlers resolve silently", async () => {
    process.env["JAZZ_WARP_SILENT"] = "1";
    const lifecycle = register();
    expect([...lifecycle.keys()].sort()).toEqual(["awaiting-input", "run-complete"]);
    await expect(
      lifecycle
        .get("run-complete")!
        .handler(event({ event: "run-complete", data: { summary: "done" } }), {
          signal: new AbortController().signal,
        }),
    ).resolves.toBeUndefined();
  });
});
