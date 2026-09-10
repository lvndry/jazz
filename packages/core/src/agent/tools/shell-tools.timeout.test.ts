import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { createShellCommandTools, runShellCommand } from "./shell-tools";
import { SHELL_COMMAND_MAX_TIMEOUT_MS } from "../../constants/agent";
import type { ToolExecutionContext, ToolExecutionResult } from "../../types";

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
    expect(result.error).toContain("register_trigger");
  });

  it("caps the executor deadline at the same value the schema allows", () => {
    expect(tools.execute.timeoutMs).toBe(SHELL_COMMAND_MAX_TIMEOUT_MS);
  });
});
