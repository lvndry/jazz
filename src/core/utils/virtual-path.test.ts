import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  resolveVirtualPath,
  splitVirtualPathIntoSegments,
  VirtualPathViolation,
} from "./virtual-path";

const options = {
  maxDepth: 2,
  maxSegmentLength: 16,
} as const;

describe("splitVirtualPathIntoSegments", () => {
  test("normalizes leading slashes without treating them as OS roots", () => {
    expect(splitVirtualPathIntoSegments("/people/user.md", options)).toEqual(["people", "user.md"]);
  });

  test("enforces configurable path limits", () => {
    expect(() => splitVirtualPathIntoSegments("a/b/c", options)).toThrow(VirtualPathViolation);
    expect(() => splitVirtualPathIntoSegments("a/this-name-is-too-long", options)).toThrow(
      VirtualPathViolation,
    );
  });

  test("rejects traversal, empty segments, backslashes, and null bytes", () => {
    for (const unsafePath of ["../secret", "./file", "a//b", String.raw`a\b`, "a\0b"]) {
      expect(() => splitVirtualPathIntoSegments(unsafePath, options)).toThrow(VirtualPathViolation);
    }
  });
});

describe("resolveVirtualPath", () => {
  test("rejects symlinks under the virtual root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-virtual-path-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-virtual-path-outside-"));
    fs.symlinkSync(outside, path.join(root, "link"));

    try {
      const result = await Effect.runPromise(
        resolveVirtualPath(root, "link/file.txt", options).pipe(Effect.either),
      );
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(VirtualPathViolation);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
