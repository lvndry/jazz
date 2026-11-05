import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  compareUnknownCasts,
  countUnknownCasts,
  findUnknownCasts,
  scanUnknownCasts,
} from "./verify-no-unknown-casts";

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function repositoryWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "jazz-unknown-casts-"));
  temporaryRoots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  }
  return root;
}

describe("findUnknownCasts", () => {
  it("finds as, angle-bracket and union assertions to unknown", () => {
    const source = [
      "const first = value as unknown;",
      "const second = <unknown>value;",
      "const third = value as unknown | string;",
      "const fourth = value as (unknown);",
    ].join("\n");
    expect(
      findUnknownCasts("packages/core/src/example.ts", source).map((cast) => cast.line),
    ).toEqual([1, 2, 3, 4]);
  });

  it("ignores comments, strings, type arguments and other assertions", () => {
    const source = [
      "// value as unknown",
      'const text = "value as unknown";',
      "const list: Array<unknown> = [];",
      "const typed = value as string;",
      "const parsed: unknown = JSON.parse(text);",
    ].join("\n");
    expect(findUnknownCasts("packages/core/src/example.ts", source)).toEqual([]);
  });

  it("fingerprints by tokens, not by position", () => {
    const [moved] = findUnknownCasts("packages/a.ts", "\n\nconst a = x as unknown;");
    const [original] = findUnknownCasts("packages/a.ts", "const a   =   x as unknown; // note");
    expect(moved?.fingerprint).toBe(original?.fingerprint);
  });
});

describe("compareUnknownCasts", () => {
  const casts = findUnknownCasts(
    "packages/a.ts",
    "const a = x as unknown;\nconst b = y as unknown;",
  );

  it("passes when every assertion is recorded", () => {
    const report = compareUnknownCasts(casts, countUnknownCasts(casts));
    expect(report.added).toEqual([]);
    expect(report.stale).toEqual([]);
  });

  it("reports an assertion the baseline does not cover", () => {
    const report = compareUnknownCasts(casts, countUnknownCasts(casts.slice(0, 1)));
    expect(report.added.map((cast) => cast.line)).toEqual([2]);
  });

  it("reports a baseline entry that no longer exists", () => {
    const report = compareUnknownCasts(casts.slice(0, 1), countUnknownCasts(casts));
    expect(report.added).toEqual([]);
    expect(report.stale).toHaveLength(1);
  });

  it("counts a repeated identical assertion separately", () => {
    const repeated = findUnknownCasts("packages/a.ts", "f(x as unknown);\nf(x as unknown);");
    const report = compareUnknownCasts(repeated, countUnknownCasts(repeated.slice(0, 1)));
    expect(report.added).toHaveLength(1);
  });
});

describe("scanUnknownCasts", () => {
  const isRoot = process.getuid?.() === 0;

  it.skipIf(isRoot)("fails naming a file it cannot read", () => {
    const root = repositoryWith({
      "packages/a.ts": "export const a = 1 as unknown;",
      "scripts/b.ts": "export const b = 1;",
    });
    chmodSync(path.join(root, "packages/a.ts"), 0o000);
    expect(() => scanUnknownCasts(root)).toThrow("packages/a.ts");
  });

  it("skips a tracked file that was deleted", () => {
    const root = repositoryWith({
      "packages/a.ts": "export const a = 1 as unknown;",
      "packages/gone.ts": "export const gone = 1 as unknown;",
      "scripts/b.ts": "export const b = 1;",
    });
    execFileSync("git", ["add", "-A"], { cwd: root });
    rmSync(path.join(root, "packages/gone.ts"));
    expect(scanUnknownCasts(root).map((cast) => cast.file)).toEqual(["packages/a.ts"]);
  });
});
