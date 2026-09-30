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

  it("polls repeatedly within the budget rather than once per call", async () => {
    const outcome = await poll("false", WAIT_FOR_MIN_INTERVAL_MS, 2_000);

    expect(outcome.attempts).toBeGreaterThanOrEqual(3);
  });
});
