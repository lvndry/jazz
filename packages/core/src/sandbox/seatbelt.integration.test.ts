import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getConfinementStatus } from "./backend";
import { planLaunch } from "./confine";
import { classifyWriteDenial } from "./denial";
import { findRepositoryRoots } from "./repository-roots";
import { buildWritePolicy } from "./write-policy";

/**
 * Runs real commands under the host's confinement backend. Skipped where none provides `full`
 * confinement, so CI hosts without one do not fail.
 */
const status = getConfinementStatus();
const describeConfined = status.level === "full" ? describe : describe.skip;

let base: string;
let workspace: string;
let outside: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jazz-confinement-it-")));
  workspace = path.join(base, "workspace");
  outside = mkdtempSync(path.join(process.cwd(), ".confinement-it-outside-"));
  mkdirSync(workspace);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function runConfined(script: string): { exitCode: number; stderr: string } {
  const policy = buildWritePolicy({
    workspace,
    homeDir: path.join(base, "home"),
    jazzScratchDirectory: path.join(base, "scratch"),
    platform: process.platform,
    tempDirectory: path.join(base, "no-temp"),
  });
  const plan = planLaunch({ mode: "on", policy, argv: ["sh", "-c", script], status });
  if (plan.kind !== "confined") {
    throw new Error("expected a confined plan");
  }
  const [command, ...args] = plan.argv;
  const result = Bun.spawnSync([command ?? "", ...args], {
    cwd: workspace,
    stderr: "pipe",
    stdout: "pipe",
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

describeConfined("real confined shell", () => {
  test("writes inside the workspace succeed", () => {
    const result = runConfined('echo inside > "$PWD/ok.txt"');
    expect(result.exitCode).toBe(0);
    expect(readFileSync(path.join(workspace, "ok.txt"), "utf8")).toBe("inside\n");
  });

  test("writes outside the roots are refused and classified as a denial", () => {
    const target = path.join(outside, "blocked.txt");
    const result = runConfined(`echo nope > "${target}"`);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(target)).toBe(false);
    const policy = buildWritePolicy({
      workspace,
      homeDir: path.join(base, "home"),
      jazzScratchDirectory: path.join(base, "scratch"),
      platform: process.platform,
      tempDirectory: path.join(base, "no-temp"),
    });
    const denial = classifyWriteDenial({
      exitCode: result.exitCode,
      stderr: result.stderr,
      policy,
      cwd: workspace,
    });
    expect(denial?.deniedPath).toBe(target);
  });

  test("a symlink out of the workspace cannot be written through", () => {
    const result = runConfined(
      `ln -s "${outside}" "$PWD/escape" && echo x > "$PWD/escape/via-link.txt"`,
    );
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(path.join(outside, "via-link.txt"))).toBe(false);
  });

  test("deleting outside the roots is refused", () => {
    const target = path.join(outside, "keep.txt");
    Bun.write(target, "keep");
    const result = runConfined(`rm "${target}"`);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(target)).toBe(true);
  });

  test("reads outside the roots and the network stay open", () => {
    const result = runConfined("cat /etc/hosts > /dev/null && ls / > /dev/null");
    expect(result.exitCode).toBe(0);
  });

  test("the confined shell can write to /dev/null and read its own stdin", () => {
    expect(runConfined("echo hi > /dev/null").exitCode).toBe(0);
  });

  test("git add and git commit work from a repository subdirectory", () => {
    const repository = path.join(base, "repository");
    const subdirectory = path.join(repository, "pkg");
    mkdirSync(subdirectory, { recursive: true });
    const git = (args: string[], cwd: string) =>
      Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    expect(git(["init", "-q"], repository).exitCode).toBe(0);

    const policy = buildWritePolicy({
      workspace: subdirectory,
      homeDir: path.join(base, "home"),
      jazzScratchDirectory: path.join(base, "scratch"),
      platform: process.platform,
      tempDirectory: path.join(base, "no-temp"),
      extraRoots: findRepositoryRoots(subdirectory, path.join(base, "home")),
    });
    const script =
      'echo hi > "$PWD/file.txt" && echo top > ../top.txt && git add -A && ' +
      "git -c user.name=t -c user.email=t@t.test -c commit.gpgsign=false commit -q -m init";
    const plan = planLaunch({ mode: "on", policy, argv: ["sh", "-c", script], status });
    if (plan.kind !== "confined") {
      throw new Error("expected a confined plan");
    }
    const [command, ...args] = plan.argv;
    const result = Bun.spawnSync([command ?? "", ...args], {
      cwd: subdirectory,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(git(["log", "--oneline"], repository).stdout.toString()).toContain("init");
  });
});
