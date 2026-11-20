import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { spawnDetachedCommand } from "./spawn-job-worker";

describe("spawnDetachedCommand", () => {
  it("reports a missing executable as not spawned instead of throwing later", async () => {
    const result = await Effect.runPromise(
      spawnDetachedCommand("/nonexistent/jazz-binary-for-test", ["--version"]),
    );
    expect(result.spawned).toBe(false);
    expect(result.reason).toContain("ENOENT");
  });

  it("reports a started executable as spawned", async () => {
    const result = await Effect.runPromise(spawnDetachedCommand(process.execPath, ["--version"]));
    expect(result).toEqual({ spawned: true });
  });
});
