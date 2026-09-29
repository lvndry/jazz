/**
 * End-to-end checks that the CLI never spins or invents answers without a
 * terminal. Each case runs the real entry point in a child process with an
 * isolated JAZZ_HOME, a hard timeout and a cap on output, so a regression to
 * the non-TTY busy loop (the chat prompt answering itself and re-prompting,
 * hundreds of thousands of lines a second) fails here instead of hanging CI.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const ENTRY = join(import.meta.dir, "entry.ts");
const CHILD_TIMEOUT_MS = 20_000;
/**
 * A busy loop that prints writes megabytes a second, and a healthy refusal a
 * few hundred bytes. A silent busy loop is caught by the timeout instead.
 */
const MAX_HEALTHY_OUTPUT_BYTES = 64 * 1024;
const AGENT_ID = "nonTtyAgent00000000001";

const jazzHome = mkdtempSync(join(tmpdir(), "jazz-non-tty-"));
mkdirSync(join(jazzHome, "agents"), { recursive: true });
writeFileSync(
  join(jazzHome, "agents", `${AGENT_ID}.json`),
  JSON.stringify({
    id: AGENT_ID,
    name: "nontty",
    model: "ollama/gemma4:12b",
    config: { persona: "default", llm: { provider: "ollama", model: "gemma4:12b" }, tools: [] },
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
  }),
);

/** Every child still running, so a failed or timed-out run never leaves one behind. */
const children = new Set<ReturnType<typeof Bun.spawn>>();

afterAll(() => {
  for (const child of children) {
    child.kill("SIGKILL");
  }
  rmSync(jazzHome, { recursive: true, force: true });
});

interface ChildResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the child wrote more than the cap and was killed for it. */
  readonly runaway: boolean;
}

/** Read a child stream up to the cap, calling `onOverflow` once it is passed. */
async function readBounded(
  stream: AsyncIterable<Uint8Array>,
  onOverflow: () => void,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length > MAX_HEALTHY_OUTPUT_BYTES) {
      onOverflow();
      break;
    }
  }
  return text;
}

async function runJazz(args: readonly string[], stdin: string | null): Promise<ChildResult> {
  const child = Bun.spawn([process.execPath, ENTRY, ...args], {
    stdin: stdin === null ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: CHILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: {
      ...process.env,
      JAZZ_HOME: jazzHome,
      JAZZ_DISABLE_KEYRING: "1",
      JAZZ_DISABLE_UPDATE_CHECK: "1",
      JAZZ_DISABLE_CATCH_UP: "1",
      JAZZ_OFFLINE: "1",
    },
  });
  children.add(child);
  let runaway = false;
  const stop = (): void => {
    runaway = true;
    child.kill("SIGKILL");
  };
  const [stdout, stderr, exitCode] = await Promise.all([
    readBounded(child.stdout, stop),
    readBounded(child.stderr, stop),
    child.exited,
  ]);
  children.delete(child);
  return { exitCode, stdout, stderr, runaway };
}

function expectBoundedOutput(result: ChildResult): void {
  expect(result.runaway).toBe(false);
}

describe("without a terminal", () => {
  let chatWithoutInput: ChildResult;
  let chatWithExit: ChildResult;
  let createAgent: ChildResult;
  let homeRuns: readonly ChildResult[];

  beforeAll(async () => {
    [chatWithoutInput, chatWithExit, createAgent, ...homeRuns] = await Promise.all([
      runJazz(["agent", "chat", AGENT_ID], null),
      runJazz(["agent", "chat", AGENT_ID], "/exit\n"),
      runJazz(["agent", "create"], null),
      runJazz([], null),
      runJazz(["--no-tui"], null),
      runJazz(["--debug"], null),
    ]);
  }, CHILD_TIMEOUT_MS + 10_000);

  test("agent chat with empty stdin exits 2 with guidance instead of spinning", () => {
    expectBoundedOutput(chatWithoutInput);
    expect(chatWithoutInput.exitCode).toBe(2);
    expect(chatWithoutInput.stderr).toContain("no messages arrived on stdin");
    expect(chatWithoutInput.stdout).not.toContain("(Tip)");
  });

  test("agent chat reads piped lines and exits 0 at /exit", () => {
    expectBoundedOutput(chatWithExit);
    expect(chatWithExit.exitCode).toBe(0);
  });

  test("agent create refuses with exit 2 and points at the agent JSON", () => {
    expectBoundedOutput(createAgent);
    expect(createAgent.exitCode).toBe(2);
    expect(createAgent.stderr).toContain("agents/<id>.json");
  });

  test("bare jazz, with or without global flags, refuses without saving onboarding choices", () => {
    expect(homeRuns).toHaveLength(3);
    for (const result of homeRuns) {
      expectBoundedOutput(result);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).not.toContain("Notifications enabled");
    }
    expect(existsSync(join(jazzHome, "config.json"))).toBe(false);
  });
});
