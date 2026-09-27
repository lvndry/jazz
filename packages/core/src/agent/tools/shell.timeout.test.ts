import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Fiber, Layer } from "effect";
import { createShellCommandTools, runShellCommand } from "./shell";
import { SHELL_COMMAND_MAX_TIMEOUT_MS } from "../../constants/agent";
import type { ToolExecutionContext, ToolExecutionResult } from "../../types";
import { terminateProcessGroup } from "../../utils/process";

/**
 * A command killed at its cap has usually already produced the output somebody wanted. The
 * timeout path used to fail without reading the buffer it had collected, so a background job
 * that logged for fourteen minutes and then hit the ceiling reported nothing whatsoever.
 */
describe("runShellCommand when the clock runs out", () => {
  function run(command: string, timeoutMs: number) {
    return Effect.runPromise(
      runShellCommand({ command, workingDir: process.cwd(), timeoutMs, env: process.env }),
    );
  }

  it("returns what the command printed before it was killed", async () => {
    const result = await run("echo i-got-this-far; sleep 30", 1500);

    expect(result.stdout).toContain("i-got-this-far");
  });

  it("reports the timeout exit code rather than success", async () => {
    const result = await run("echo partial; sleep 30", 1500);

    expect(result.exitCode).toBe(124);
  });

  it("says in stderr that it was killed, so the output is not read as complete", async () => {
    const result = await run("echo partial; sleep 30", 1500);

    expect(result.stderr).toContain("timed out");
  });

  it("leaves a command that finishes in time completely alone", async () => {
    const result = await run("echo all-of-it", 10_000);

    expect(result.stdout.trim()).toBe("all-of-it");
    expect(result.exitCode).toBe(0);
  });

  it("does not call a command killed by a signal a success", async () => {
    const result = await run("kill -TERM $$", 10_000);

    expect(result.exitCode).not.toBe(0);
  });
});

/**
 * The executor interrupts a tool call at its own deadline and reports a bare timeout message,
 * dropping the partial output the command runner's deadline would have preserved. A request for
 * more time than the executor allows therefore bought the same wait with a worse result, so the
 * schema refuses it and names the tool that does span longer waits.
 */
describe("the execute_command timeout ceiling", () => {
  const tools = createShellCommandTools();

  function runWithTimeout(timeout: number) {
    return Effect.runPromise(
      tools.approval
        .execute({ command: "echo hi", description: "test", timeout }, {} as ToolExecutionContext)
        .pipe(Effect.provide(Layer.empty)) as Effect.Effect<ToolExecutionResult, Error>,
    );
  }

  it("rejects a timeout above the ceiling instead of silently capping it", async () => {
    const result = await runWithTimeout(SHELL_COMMAND_MAX_TIMEOUT_MS + 1);

    expect(result.success).toBe(false);
    expect(result.error).toContain(`at most ${String(SHELL_COMMAND_MAX_TIMEOUT_MS)}`);
  });

  it("caps the executor deadline at the same value the schema allows", () => {
    expect(tools.execute.timeoutMs).toBe(SHELL_COMMAND_MAX_TIMEOUT_MS);
  });
});

/**
 * A command's children belong to its process group, so stopping the command stops them too, and
 * a job the command leaves running in the background does not hold the call open.
 */
describe("runShellCommand and the processes a command starts", () => {
  const scratchDirectories: string[] = [];
  const strayPids: number[] = [];

  afterEach(() => {
    for (const pid of strayPids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    for (const directory of scratchDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function pidFile(): string {
    const directory = mkdtempSync(join(tmpdir(), "jazz-shell-group-"));
    scratchDirectories.push(directory);
    return join(directory, "child.pid");
  }

  async function readPid(path: string): Promise<number> {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
        if (Number.isInteger(pid) && pid > 0) {
          strayPids.push(pid);
          return pid;
        }
      } catch {
        // Not written yet.
      }
      await Bun.sleep(20);
    }
    throw new Error(`no pid written to ${path}`);
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitUntilGone(pid: number): Promise<boolean> {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!isAlive(pid)) {
        return true;
      }
      await Bun.sleep(20);
    }
    return false;
  }

  it("kills the command's children when the tool call is interrupted", async () => {
    const path = pidFile();
    const fiber = Effect.runFork(
      runShellCommand({
        command: `sleep 45 & echo $! > '${path}'; wait`,
        workingDir: process.cwd(),
        timeoutMs: 30_000,
        env: process.env,
      }),
    );
    const childPid = await readPid(path);

    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(await waitUntilGone(childPid)).toBe(true);
  });

  it("kills the command's children when it runs out of time", async () => {
    const path = pidFile();
    const pending = Effect.runPromise(
      runShellCommand({
        command: `sleep 45 & echo $! > '${path}'; wait`,
        workingDir: process.cwd(),
        timeoutMs: 500,
        env: process.env,
      }),
    );
    const childPid = await readPid(path);
    const result = await pending;

    expect(result.exitCode).toBe(124);
    expect(await waitUntilGone(childPid)).toBe(true);
  });

  it("lets an interrupted command handle SIGTERM and clean up before it is killed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jazz-shell-term-"));
    scratchDirectories.push(directory);
    const ready = join(directory, "ready");
    const cleaned = join(directory, "cleaned");
    const fiber = Effect.runFork(
      runShellCommand({
        command: `trap 'echo done > "${cleaned}"; exit 0' TERM; echo up > "${ready}"; while true; do sleep 0.1; done`,
        workingDir: process.cwd(),
        timeoutMs: 30_000,
        env: process.env,
      }),
    );
    for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++) {
      await Bun.sleep(20);
    }

    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(readFileSync(cleaned, "utf8").trim()).toBe("done");
  });

  it("kills a command that ignores SIGTERM once the grace period is over", async () => {
    const path = pidFile();
    const child = spawn(
      "sh",
      ["-c", `trap '' TERM; echo $$ > '${path}'; while true; do sleep 0.1; done`],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    const pid = await readPid(path);
    const startedAt = Date.now();

    await terminateProcessGroup(child, 300);

    expect(await waitUntilGone(pid)).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(290);
  });

  it("returns once the shell exits, even while a background job holds its output open", async () => {
    const path = pidFile();
    const startedAt = Date.now();
    const result = await Effect.runPromise(
      runShellCommand({
        command: `sleep 45 & echo $! > '${path}'; echo started`,
        workingDir: process.cwd(),
        timeoutMs: 30_000,
        env: process.env,
      }),
    );
    await readPid(path);

    expect(result.stdout.trim()).toBe("started");
    expect(result.exitCode).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
