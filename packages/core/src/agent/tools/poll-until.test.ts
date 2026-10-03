import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { WAIT_FOR_MIN_INTERVAL_MS } from "@/core/constants/agent";
import { pollUntilSuccess } from "./poll-until";

function poll(command: string, intervalMs: number, timeoutMs: number) {
  return Effect.runPromise(
    pollUntilSuccess({
      command,
      workingDir: process.cwd(),
      intervalMs,
      timeoutMs,
      env: process.env,
    }),
  );
}

describe("pollUntilSuccess", () => {
  it("returns as soon as the condition holds, without waiting out the interval", async () => {
    const started = Date.now();
    const outcome = await poll("true", 10_000, 30_000);

    expect(outcome.matched).toBe(true);
    expect(outcome.attempts).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("keeps checking until a condition that starts false comes true", async () => {
    const counter = `${tmpdir()}/poll-until-counter-${String(process.pid)}`;
    rmSync(counter, { force: true });

    const outcome = await poll(
      `count=$(cat ${counter} 2>/dev/null || echo 0); count=$((count+1)); echo $count > ${counter}; test $count -ge 3`,
      WAIT_FOR_MIN_INTERVAL_MS,
      10_000,
    );

    expect(outcome.matched).toBe(true);
    expect(outcome.attempts).toBe(3);
    rmSync(counter, { force: true });
  });

  it("reports running out of time with the last check's output", async () => {
    const outcome = await poll("echo still-waiting; false", WAIT_FOR_MIN_INTERVAL_MS, 1_200);

    expect(outcome.matched).toBe(false);
    expect(outcome.attempts).toBeGreaterThan(1);
    expect(outcome.stdout).toContain("still-waiting");
  });

  it("flags a timeout where every check returned the same result", async () => {
    const outcome = await poll("echo completed...; false", WAIT_FOR_MIN_INTERVAL_MS, 1_200);

    expect(outcome.matched).toBe(false);
    expect(outcome.unchanged).toBe(true);
  });

  it("drops a check the deadline killed midway, keeping the last finished one", async () => {
    const counter = `${tmpdir()}/poll-until-deadline-${String(process.pid)}`;
    rmSync(counter, { force: true });

    const outcome = await poll(
      `count=$(cat ${counter} 2>/dev/null || echo 0); count=$((count+1)); echo $count > ${counter}; echo checked; test $count -ge 2 && sleep 5; false`,
      WAIT_FOR_MIN_INTERVAL_MS,
      1_000,
    );

    expect(outcome.attempts).toBe(1);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout.trim()).toBe("checked");
    rmSync(counter, { force: true });
  });

  it("does not flag a timeout whose checks saw something change", async () => {
    const outcome = await poll("echo $$; false", WAIT_FOR_MIN_INTERVAL_MS, 1_200);

    expect(outcome.matched).toBe(false);
    expect(outcome.unchanged).toBe(false);
  });

  it("polls repeatedly within the budget rather than once per call", async () => {
    const outcome = await poll("false", WAIT_FOR_MIN_INTERVAL_MS, 2_000);

    expect(outcome.attempts).toBeGreaterThanOrEqual(3);
  });

  it("reports every check to onCheck, the matching one included", async () => {
    const counter = `${tmpdir()}/poll-until-oncheck-${String(process.pid)}`;
    rmSync(counter, { force: true });
    const seen: { attempts: number; exitCode: number; stdout: string }[] = [];

    await Effect.runPromise(
      pollUntilSuccess({
        command: `count=$(cat ${counter} 2>/dev/null || echo 0); count=$((count+1)); echo $count > ${counter}; echo step-$count; test $count -ge 2`,
        workingDir: process.cwd(),
        intervalMs: WAIT_FOR_MIN_INTERVAL_MS,
        timeoutMs: 10_000,
        env: process.env,
        onCheck: (check) =>
          Effect.sync(() => {
            seen.push({
              attempts: check.attempts,
              exitCode: check.exitCode,
              stdout: check.stdout.trim(),
            });
          }),
      }),
    );

    expect(seen).toEqual([
      { attempts: 1, exitCode: 1, stdout: "step-1" },
      { attempts: 2, exitCode: 0, stdout: "step-2" },
    ]);
    rmSync(counter, { force: true });
  });
});
