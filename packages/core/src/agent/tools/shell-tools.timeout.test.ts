import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { runShellCommand } from "./shell-tools";

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
