import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { testConfigLayer } from "@/core/agent/test-config";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types/tools";
import {
  createComputerObserveTool,
  createComputerPointerTools,
  createComputerWaitTool,
} from "./computer-tools";
import { mailApp, type FakeApp } from "./fake-driver";
import { ComputerSessions } from "./session";
import { useTemporaryJazzHome } from "./test-home";
import { type Started, startSession } from "./test-session";

useTemporaryJazzHome();

const observe = createComputerObserveTool();
const pointer = createComputerPointerTools();
const wait = createComputerWaitTool();

function run(tool: unknown, args: Record<string, unknown>, context: ToolExecutionContext) {
  const asTool = tool as Tool<never>;
  return Effect.runPromise(
    (asTool.execute(args, context) as Effect.Effect<ToolExecutionResult, never, never>).pipe(
      Effect.provide(testConfigLayer()),
    ),
  );
}

async function contextFor(started: Started): Promise<ToolExecutionContext> {
  const sessions = new ComputerSessions();
  await sessions.obtain(async () => started.session);
  return {
    agentId: "agent-1",
    conversationId: "conversation-1",
    computerSessions: sessions,
  };
}

/** A mail app the test can reshape between window reads. */
function mutableMailApp() {
  const app = mailApp();
  const windows = app.windows.map((window) => ({ ...window }));
  return { app: { ...app, windows } as FakeApp, windows } as const;
}

describe("captureAfter", () => {
  test("an action with captureAfter returns the after-state in the same reply", async () => {
    const { app, windows } = mutableMailApp();
    const started = startSession([app], ["com.apple.mail"]);
    const context = await contextFor(started);
    await run(observe, {}, context);
    started.session.approveForRun("com.apple.mail", "Mail");

    // The window gains a control between the action and the after-capture.
    started.driver.mutate = () => {
      const window = windows[0];
      if (window !== undefined && !window.elements.some((element) => element.label === "Sent")) {
        window.elements = [...window.elements, { role: "AXButton", label: "Sent" }];
      }
    };

    const result = (
      await run(pointer.execute, { action: "click", ref: "c1.0", captureAfter: true }, context)
    ).result as string;
    expect(result).toContain("observation: c2");
    expect(result).toContain("Sent");

    // The fresh refs work; the pre-capture observation's refs are retired.
    const freshRef = result.match(/c2\.\d+/)?.[0];
    expect(freshRef).toBeDefined();
    const followUp = await run(pointer.execute, { action: "click", ref: freshRef }, context);
    expect(followUp.success).toBe(true);
    await expect(
      started.session.perform({ kind: "click", ref: "c1.0", delivery: "background" }, []),
    ).rejects.toThrow();
  });

  test("an action without captureAfter does not carry an observation", async () => {
    const started = startSession([mailApp()], ["com.apple.mail"]);
    const context = await contextFor(started);
    await run(observe, {}, context);
    started.session.approveForRun("com.apple.mail", "Mail");

    const result = (await run(pointer.execute, { action: "click", ref: "c1.0" }, context))
      .result as string;
    expect(result).not.toContain("observation: c2");
  });
});

describe("computer_wait", () => {
  test("settles when the window stops changing", async () => {
    const { app, windows } = mutableMailApp();
    const started = startSession([app], ["com.apple.mail"]);
    const context = await contextFor(started);
    await run(observe, {}, context);
    let flips = 0;
    started.driver.mutate = () => {
      if (flips >= 2) return;
      flips += 1;
      const window = windows[0];
      if (window !== undefined) {
        window.elements = [
          ...window.elements,
          { role: "AXButton", label: `Change${String(flips)}` },
        ];
      }
    };

    const result = (await run(wait, { timeoutMs: 5000, pollMs: 200 }, context)).result as string;
    expect(result).toContain("settled");
    expect(result).toContain("observation: c2");
    expect(result).toContain("Change2");
  });

  test("changed returns as soon as the window differs from the first read", async () => {
    const { app, windows } = mutableMailApp();
    const started = startSession([app], ["com.apple.mail"]);
    const context = await contextFor(started);
    await run(observe, {}, context);
    let reads = 0;
    started.driver.mutate = () => {
      reads += 1;
      if (reads < 2) return; // first read is the baseline; change on the second
      const window = windows[0];
      if (window !== undefined) {
        window.elements = [...window.elements, { role: "AXButton", label: "New" }];
      }
    };

    const result = (await run(wait, { timeoutMs: 5000, pollMs: 200, until: "changed" }, context))
      .result as string;
    expect(result).toContain("changed");
  });

  test("reports the timeout with the final observation when the window keeps changing", async () => {
    const { app, windows } = mutableMailApp();
    const started = startSession([app], ["com.apple.mail"]);
    const context = await contextFor(started);
    await run(observe, {}, context);
    let ticks = 0;
    started.driver.mutate = () => {
      ticks += 1;
      const window = windows[0];
      if (window !== undefined) {
        window.elements = [...window.elements, { role: "AXButton", label: `t${String(ticks)}` }];
      }
    };

    const result = (await run(wait, { timeoutMs: 400, pollMs: 100 }, context)).result as string;
    expect(result).toContain("had not settled");
    expect(result).toContain("observation:");
  });

  test("fails clearly when nothing was observed first", async () => {
    const started = startSession([mailApp()], ["com.apple.mail"]);
    const context = await contextFor(started);

    const result = await run(wait, { timeoutMs: 400, pollMs: 100 }, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Observe a window first");
  });

  test("refreshes the idle clock on every poll, so a long wait cannot lapse the run", async () => {
    const { app, windows } = mutableMailApp();
    const started = startSession([app], ["com.apple.mail"]);
    await started.session.observe({ screenshot: false }, []);

    // The window changes on every poll, so the wait runs to its full timeout while
    // the clock advances well past the idle limit.
    let ticks = 0;
    started.driver.mutate = () => {
      ticks += 1;
      const window = windows[0];
      if (window !== undefined) {
        window.elements = [
          ...window.elements,
          { role: "AXButton", label: `tick-${String(ticks)}` },
        ];
      }
    };
    started.clock.now += 29 * 60 * 1000;

    // The wait runs a second of polls while the fake clock sits past the 30-minute idle
    // limit: if any poll failed to refresh lastActionAt, the session would lapse.
    const report = await started.session.wait({ timeoutMs: 1000, pollMs: 50, until: "settled" });
    expect(report.outcome).toBe("timeout");
    const after = await started.session.observe({ screenshot: false }, []);
    expect(after.generation).toBeGreaterThan(1);
  });
});

describe("declarations", () => {
  test("computer_wait is read-only and private like the other computer tools", () => {
    expect(wait.name).toBe("computer_wait");
    expect(wait.riskLevel).toBe("read-only");
    expect(wait.hidden).toBe(false);
    expect(wait.disclosure).toBe("private");
  });
});
