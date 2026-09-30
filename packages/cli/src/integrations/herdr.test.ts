import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { herdrPaneAdapter, herdrResumeCommand } from "@/cli/integrations/herdr";
import type { PaneStateSnapshot } from "@/cli/integrations/pane-state";

/**
 * The adapter spawns a fire-and-forget process, so tests use a stub
 * `herdr` binary (a shell script) that appends its arguments to a file,
 * and poll that file for the expected calls.
 */

let stubDir: string;
let callsFile: string;
let savedEnv: NodeJS.ProcessEnv;

beforeAll(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-stub-"));
  callsFile = path.join(stubDir, "calls.log");
  const stubBin = path.join(stubDir, "herdr");
  fs.writeFileSync(stubBin, `#!/bin/sh\necho "$@" >> ${callsFile}\n`);
  fs.chmodSync(stubBin, 0o755);
  savedEnv = { ...process.env };
  process.env["HERDR_ENV"] = "1";
  process.env["HERDR_PANE_ID"] = "pane-test";
  process.env["HERDR_BIN_PATH"] = stubBin;
});

afterAll(() => {
  process.env = savedEnv;
  fs.rmSync(stubDir, { recursive: true, force: true });
});

function calls(): string[] {
  try {
    return fs.readFileSync(callsFile, "utf8").trim().split("\n");
  } catch {
    return [];
  }
}

async function waitForCall(substrate: string, timeoutMs = 3000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const match = calls().find((line) => line.includes(substrate));
    if (match !== undefined) return match;
    if (Date.now() - start > timeoutMs)
      throw new Error(`No call matching ${substrate} yet: ${calls().join(" | ")}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function clearCalls(): void {
  fs.writeFileSync(callsFile, "");
}

function baseSnapshot(): PaneStateSnapshot {
  return {
    activity: { phase: "streaming" } as PaneStateSnapshot["activity"],
    approvalRequest: null,
    activeMenu: null,
    currentConversation: { agentId: "coder", conversationId: "conv-1" },
  };
}

describe("herdrResumeCommand", () => {
  test("builds a plain-on-PATH resume command", () => {
    expect(herdrResumeCommand("coder", "abc-123")).toEqual([
      "jazz",
      "agent",
      "chat",
      "coder",
      "--continue",
      "--conversation",
      "abc-123",
    ]);
  });

  test("has no quotes, backslashes, or control characters in any argument", () => {
    for (const arg of herdrResumeCommand("coder", "conv-1")) {
      expect(arg.includes("'") || arg.includes('"') || arg.includes("\\")).toBe(false);
      expect(
        [...arg].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20 || ch.codePointAt(0) === 0x7f),
      ).toBe(false);
    }
  });
});

describe("herdrPaneAdapter", () => {
  test("is active when the Herdr environment is present", () => {
    expect(herdrPaneAdapter().isActive).toBe(true);
    expect(herdrPaneAdapter().name).toBe("herdr");
  });

  test("reports working state with session id and resume command", async () => {
    clearCalls();
    const adapter = herdrPaneAdapter();
    adapter.onSnapshot(baseSnapshot());
    const call = await waitForCall("report-agent");
    expect(call).toContain(
      "pane report-agent pane-test --source jazz --agent coder --state working",
    );
    expect(call).toContain("--seq");
    expect(call).toContain("--agent-session-id conv-1");
    expect(call).toContain("-- jazz agent chat coder --continue --conversation conv-1");
  });

  test("reports blocked with a reason when an approval is pending", async () => {
    clearCalls();
    const adapter = herdrPaneAdapter();
    adapter.onSnapshot({
      ...baseSnapshot(),
      activity: { phase: "tool-execution" } as PaneStateSnapshot["activity"],
      approvalRequest: { toolName: "execute_command", args: { command: "npm install" } },
    });
    const call = await waitForCall("blocked");
    expect(call).toContain("--state blocked");
    expect(call).toContain("--message Approval needed: execute_command npm install");
  });

  test("seq numbers strictly increase across reports", async () => {
    clearCalls();
    const adapter = herdrPaneAdapter();
    adapter.onSnapshot(baseSnapshot());
    adapter.onSnapshot({
      ...baseSnapshot(),
      activity: { phase: "idle" } as PaneStateSnapshot["activity"],
    });
    // Fire-and-forget spawns can land in the log out of order, so pair each
    // seq with its state and check the ordering by state, not by log line.
    await waitForCall("--state idle");
    await waitForCall("--state working");
    const seqByState = new Map<string, number>();
    for (const line of calls()) {
      const seq = line.match(/--seq (\d+)/);
      const state = line.match(/--state (\w+)/);
      if (seq === null || state === null) continue;
      const stateName = state[1];
      const seqNum = Number(seq[1]);
      if (stateName !== undefined) seqByState.set(stateName, seqNum);
    }
    const working = seqByState.get("working");
    const idle = seqByState.get("idle");
    expect(working).toBeTypeOf("number");
    expect(idle).toBeTypeOf("number");
    if (working !== undefined && idle !== undefined) {
      expect(idle).toBeGreaterThan(working);
    }
  });

  test("release reports release-agent and makes later snapshots no-ops", async () => {
    clearCalls();
    const adapter = herdrPaneAdapter();
    adapter.onSnapshot(baseSnapshot());
    adapter.release();
    const releaseCall = await waitForCall("release-agent");
    expect(releaseCall).toContain("pane release-agent pane-test --source jazz");
    clearCalls();
    adapter.onSnapshot(baseSnapshot());
    // Give a late report a chance to (incorrectly) appear.
    await new Promise((r) => setTimeout(r, 150));
    expect(calls().filter((line) => line.includes("report-agent"))).toHaveLength(0);
  });
});
