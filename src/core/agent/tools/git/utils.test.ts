import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { runGitCommand, withGitTruncation, type GitCommandResult } from "./utils";

function gitResult(overrides: Partial<GitCommandResult> = {}): GitCommandResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

describe("withGitTruncation", () => {
  it("leaves the payload unchanged when nothing overflowed", () => {
    const payload = { workingDirectory: "/tmp" };
    expect(withGitTruncation(payload, gitResult())).toEqual(payload);
  });

  it("sets truncated when stdout or stderr overflowed", () => {
    const payload = { workingDirectory: "/tmp" };
    expect(withGitTruncation(payload, gitResult({ stdoutTruncated: true }))).toEqual({
      ...payload,
      truncated: true,
    });
    expect(withGitTruncation(payload, gitResult({ stderrTruncated: true }))).toEqual({
      ...payload,
      truncated: true,
    });
  });
});

describe("runGitCommand", () => {
  it("returns untruncated output for a small git command", async () => {
    const result = await Effect.runPromise(
      runGitCommand({
        args: ["rev-parse", "--is-inside-work-tree"],
        workingDirectory: process.cwd(),
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
    expect(result.stdout.trim()).toBe("true");
  });
});
