/**
 * Exercise startup failures through the real CLI, before its application layer exists.
 * Isolated homes and offline children verify the one-envelope contract without model calls.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const ENTRY = join(import.meta.dir, "entry.ts");

async function runWithBrokenConfig(args: readonly string[], missing = false) {
  const home = mkdtempSync(join(tmpdir(), "jazz-startup-failure-"));
  const config = join(home, "config.json");
  if (!missing) {
    writeFileSync(config, JSON.stringify({ autoApprove: "not-a-setting" }));
  }
  try {
    const child = Bun.spawn([process.execPath, ENTRY, "--config", config, ...args], {
      cwd: home,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        JAZZ_HOME: home,
        JAZZ_DISABLE_KEYRING: "1",
        JAZZ_DISABLE_UPDATE_CHECK: "1",
        JAZZ_DISABLE_CATCH_UP: "1",
        JAZZ_OFFLINE: "1",
      },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("startup failure output", () => {
  for (const args of [
    ["run", "hello", "--agent", "test"],
    ["workflow", "run", "test"],
  ]) {
    for (const missing of [false, true]) {
      it(`${args[0]} --json reports ${missing ? "missing" : "invalid"} config in one envelope`, async () => {
        const result = await runWithBrokenConfig([...args, "--json"], missing);
        expect(result.exitCode).toBe(1);
        expect(result.stdout.trim().split("\n")).toHaveLength(1);
        expect(result.stdout.trim()).not.toBe("");
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          code: "failed",
          costUSD: 0,
          error: expect.stringContaining("config"),
        });
        expect(result.stderr).toContain("config");
      }, 30_000);
    }
  }

  for (const args of [["runs", "list"], ["spend"]]) {
    it(`${args.join(" ")} --json reports invalid config in one { ok, error } envelope`, async () => {
      const result = await runWithBrokenConfig([...args, "--json"]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        error: expect.stringContaining("config"),
      });
      expect(result.stderr).toContain("config");
    }, 30_000);
  }

  it("keeps plain list failures on stderr with empty stdout", async () => {
    const result = await runWithBrokenConfig(["runs", "list"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("config");
  }, 30_000);

  it("keeps plain run failures on stderr with empty stdout", async () => {
    const result = await runWithBrokenConfig(["run", "hello", "--agent", "test"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("config");
  }, 30_000);
});
