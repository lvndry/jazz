import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { isBrokenPipe } from "./broken-pipe";

describe("isBrokenPipe", () => {
  it("recognizes only EPIPE", () => {
    expect(isBrokenPipe(Object.assign(new Error("broken pipe"), { code: "EPIPE" }))).toBe(true);
    expect(isBrokenPipe(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
    expect(isBrokenPipe("EPIPE")).toBe(false);
  });
});

describe("a closed stdout", () => {
  it("ends the CLI quietly with the command's exit code", { timeout: 60_000 }, async () => {
    const home = mkdtempSync(path.join(tmpdir(), "jazz-broken-pipe-"));
    try {
      const child = Bun.spawn(["bun", `${import.meta.dir}/main.ts`, "skill", "list", "--json"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          JAZZ_HOME: home,
          JAZZ_DISABLE_KEYRING: "1",
          JAZZ_DISABLE_UPDATE_CHECK: "1",
          JAZZ_DISABLE_CATCH_UP: "1",
        },
      });
      await child.stdout.cancel();
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(stderr).not.toContain("EPIPE");
      expect(exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
