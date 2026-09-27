import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

interface RunOutcome {
  readonly kind: "answered" | "failed" | "parked";
  readonly answer?: string;
  readonly headline?: string;
  readonly detail?: string;
  readonly transient?: boolean;
  readonly capped?: boolean;
}

const runOutcome = createRequire(import.meta.url)("../.github/jazz/scripts/run-outcome.cjs") as {
  readRunOutcome: (outputPath: string, exitCodePath: string) => RunOutcome;
  describeFailure: (outcome: RunOutcome, runUrl: string, subject: string) => string;
};

describe("readRunOutcome (jazz.yml posting steps)", () => {
  let directory: string;
  let outputPath: string;
  let exitCodePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "jazz-run-outcome-"));
    outputPath = join(directory, "out.txt");
    exitCodePath = join(directory, "exit");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function capture(stdout: string, exitCode: number): RunOutcome {
    writeFileSync(outputPath, stdout);
    writeFileSync(exitCodePath, `${exitCode}\n`);
    return runOutcome.readRunOutcome(outputPath, exitCodePath);
  }

  it("names a rejected API key as an authentication failure and redacts the key", () => {
    const outcome = capture(
      `${JSON.stringify({
        ok: false,
        error:
          'Authentication failed for LLM provider "openai": Incorrect API key provided: sk-proj-********1N8A.',
        costUSD: 0,
      })}\n`,
      1,
    );

    expect(outcome.kind).toBe("failed");
    expect(outcome.headline).toBe("provider authentication failed");
    expect(outcome.transient).toBe(false);
    expect(outcome.detail).not.toContain("1N8A");
    expect(runOutcome.describeFailure(outcome, "https://run", "Review")).toStartWith(
      "Review skipped: provider authentication failed.",
    );
  });

  it("marks a rate limit as transient so the job is not failed for it", () => {
    const outcome = capture(
      `${JSON.stringify({ ok: false, error: "LLMRateLimitError: 429 Too Many Requests" })}\n`,
      1,
    );

    expect(outcome.headline).toBe("the provider rate-limited the run");
    expect(outcome.transient).toBe(true);
  });

  it("returns the answer of a successful envelope", () => {
    const outcome = capture(
      `${JSON.stringify({ ok: true, answer: "verdict", costUSD: 0.1 })}\n`,
      0,
    );

    expect(outcome).toMatchObject({ kind: "answered", answer: "verdict", capped: false });
  });

  it("reports a parked run with the tool that needed approval", () => {
    const outcome = capture(
      `${JSON.stringify({
        ok: false,
        state: "input-required",
        pending: { kind: "tool-approval", toolName: "execute_command", message: "git push" },
      })}\n`,
      2,
    );

    expect(outcome.kind).toBe("parked");
    expect(outcome.headline).toContain("execute_command");
  });

  it("reports a missing envelope with the exit code instead of a verdict-parse message", () => {
    const outcome = capture("Fatal error\n", 1);

    expect(outcome.kind).toBe("failed");
    expect(outcome.detail).toContain("status 1");
  });

  it("reports a run step that never wrote output", () => {
    const outcome = runOutcome.readRunOutcome(join(directory, "missing"), exitCodePath);

    expect(outcome.kind).toBe("failed");
    expect(outcome.headline).toBe("the run step did not produce any output");
  });
});
