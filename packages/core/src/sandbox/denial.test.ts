import { describe, expect, test } from "bun:test";
import { classifyWriteDenial } from "./denial";

const policy = { roots: ["/work/project", "/tmp"] };
const cwd = "/work/project";

function classify(stderr: string, exitCode = 1) {
  return classifyWriteDenial({ exitCode, stderr, policy, cwd });
}

describe("classifyWriteDenial", () => {
  test("reads a macOS shell redirect refused outside the roots", () => {
    expect(classify("sh: /nonexistent-root/hosts: Operation not permitted")?.deniedPath).toBe(
      "/nonexistent-root/hosts",
    );
  });

  test("reads a Linux read-only filesystem refusal with a quoted path", () => {
    expect(
      classify("touch: cannot touch '/nonexistent-root/x': Read-only file system")?.deniedPath,
    ).toBe("/nonexistent-root/x");
  });

  test("resolves a relative path against the command's directory", () => {
    expect(classify("sh: ../outside/y: Operation not permitted")?.deniedPath).toBe(
      "/work/outside/y",
    );
  });

  test("ignores the same error text when the path is inside a writable root", () => {
    expect(classify("sh: /work/project/locked: Operation not permitted")).toBeUndefined();
  });

  test("requires a non-zero exit", () => {
    expect(classify("sh: /nonexistent-root/hosts: Operation not permitted", 0)).toBeUndefined();
  });

  test("requires the error text at the end of the line", () => {
    expect(
      classify("Operation not permitted while writing /nonexistent-root/hosts"),
    ).toBeUndefined();
    expect(
      classify("sh: /nonexistent-root/hosts: Operation not permitted (retrying)"),
    ).toBeUndefined();
  });

  test("does not trust a shared prefix", () => {
    expect(classify("sandbox: deny file-write /nonexistent-root/hosts")).toBeUndefined();
    expect(classify("Operation not permitted")).toBeUndefined();
  });

  test("finds the denial among unrelated stderr lines", () => {
    const stderr = [
      "warning: something",
      "sh: /nonexistent-root/db/x: Operation not permitted",
      "done",
    ].join("\n");
    expect(classify(stderr)?.deniedPath).toBe("/nonexistent-root/db/x");
  });

  test("returns undefined for ordinary failures", () => {
    expect(classify("grep: pattern not found")).toBeUndefined();
    expect(classify("")).toBeUndefined();
  });
});
