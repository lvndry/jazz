import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { launchDetached } from "./notification";

const LINGERING_NOTIFIER_SECONDS = 15;
const EXIT_DEADLINE_MS = 5_000;

describe("launchDetached", () => {
  test(
    "a notifier that never exits does not keep a piped parent process alive",
    async () => {
      const script = `
      import { launchDetached } from ${JSON.stringify(join(import.meta.dir, "notification.ts"))};
      launchDetached("sleep", ["${LINGERING_NOTIFIER_SECONDS}"], () => {});
    `;
      const parent = Bun.spawn([process.execPath, "-e", script], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const startedAt = Date.now();
      const drained = Promise.all([
        new Response(parent.stdout).text(),
        new Response(parent.stderr).text(),
        parent.exited,
      ]);
      const deadline = new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), EXIT_DEADLINE_MS),
      );

      const outcome = await Promise.race([drained, deadline]);
      if (outcome === "timed-out") {
        parent.kill(9);
      }

      expect(outcome).not.toBe("timed-out");
      expect(Date.now() - startedAt).toBeLessThan(EXIT_DEADLINE_MS);
    },
    EXIT_DEADLINE_MS * 2,
  );

  test("reports a non-zero exit so the caller can fall back", async () => {
    const error = await new Promise<Error | null>((resolve) =>
      launchDetached("false", [], resolve),
    );
    expect(error?.message).toContain("exited with code 1");
  });

  test("reports a missing binary so the caller can fall back", async () => {
    const error = await new Promise<Error | null>((resolve) =>
      launchDetached("/nonexistent/jazz-notifier", [], resolve),
    );
    expect(error).not.toBeNull();
  });

  test("reports success on a clean exit", async () => {
    const error = await new Promise<Error | null>((resolve) => launchDetached("true", [], resolve));
    expect(error).toBeNull();
  });
});
