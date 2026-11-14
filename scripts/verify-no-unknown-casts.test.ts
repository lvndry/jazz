import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { findUnsafeCasts, scanUnsafeCasts } from "./verify-no-unknown-casts";

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function repositoryWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "jazz-unsafe-casts-"));
  temporaryRoots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  }
  return root;
}

function kinds(source: string): string[] {
  return findUnsafeCasts("packages/core/src/example.ts", source).map(
    (cast) => `${cast.kind}@${String(cast.line)}`,
  );
}

describe("findUnsafeCasts", () => {
  it("finds as, angle-bracket and union assertions to unknown", () => {
    const source = [
      "const first = value as unknown;",
      "const second = <unknown>value;",
      "const third = value as unknown | string;",
      "const fourth = value as (unknown);",
    ].join("\n");
    expect(kinds(source)).toEqual([
      "unknown-assertion@1",
      "unknown-assertion@2",
      "unknown-assertion@3",
      "unknown-assertion@4",
    ]);
  });

  it("finds double assertions through any, never, object and {}", () => {
    const source = [
      "const first = value as object as Target;",
      "const second = value as {} as Target;",
      "const third = value as never as Target;",
      "const fourth = value as any as Target;",
      "const fifth = (value as object) as Target;",
      "const sixth = <Target>(<never>value);",
    ].join("\n");
    expect(kinds(source)).toEqual([
      "double-assertion@1",
      "double-assertion@2",
      "double-assertion@3",
      "double-assertion@4",
      "double-assertion@5",
      "double-assertion@6",
    ]);
  });

  it("reports as-unknown-as through both the inner and the outer assertion", () => {
    expect(kinds("const value = input as unknown as Target;")).toEqual([
      "double-assertion@1",
      "unknown-assertion@1",
    ]);
  });

  it("allows single assertions, as const and double assertions through specific types", () => {
    const source = [
      "const typed = value as Target;",
      "const literal = ['a'] as const;",
      "const nested = value as Base as Derived;",
      "const record = value as Record<string, string> as Target;",
    ].join("\n");
    expect(kinds(source)).toEqual([]);
  });

  it("ignores comments, strings, type arguments and annotations", () => {
    const source = [
      "// value as unknown",
      'const text = "value as never as Target";',
      "const list: Array<unknown> = [];",
      "const parsed: unknown = JSON.parse(text);",
    ].join("\n");
    expect(kinds(source)).toEqual([]);
  });
});

describe("scanUnsafeCasts", () => {
  const isRoot = process.getuid?.() === 0;

  it("reports the file and line of each offence", () => {
    const root = repositoryWith({
      "packages/a.ts": "export const a = 1 as unknown;",
      "scripts/b.ts": "export const b = 1;",
    });
    expect(scanUnsafeCasts(root)).toEqual([
      { file: "packages/a.ts", line: 1, kind: "unknown-assertion" },
    ]);
  });

  it.skipIf(isRoot)("fails naming a file it cannot read", () => {
    const root = repositoryWith({
      "packages/a.ts": "export const a = 1 as unknown;",
      "scripts/b.ts": "export const b = 1;",
    });
    chmodSync(path.join(root, "packages/a.ts"), 0o000);
    expect(() => scanUnsafeCasts(root)).toThrow("packages/a.ts");
  });

  it("skips a tracked file that was deleted", () => {
    const root = repositoryWith({
      "packages/a.ts": "export const a = 1;",
      "packages/gone.ts": "export const gone = 1 as unknown;",
      "scripts/b.ts": "export const b = 1;",
    });
    execFileSync("git", ["add", "-A"], { cwd: root });
    rmSync(path.join(root, "packages/gone.ts"));
    expect(scanUnsafeCasts(root)).toEqual([]);
  });
});
