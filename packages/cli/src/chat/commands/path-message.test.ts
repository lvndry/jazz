import { describe, expect, it } from "bun:test";
import { startsWithPath } from "./path-message";

describe("startsWithPath", () => {
  const nothingExists = () => false;

  it("reads a word with a second slash as a path", () => {
    expect(startsWithPath("/Users/me/shot.png", nothingExists)).toBe(true);
    expect(startsWithPath("/tmp/", nothingExists)).toBe(true);
  });

  it("reads a single-segment word as a path only when it exists", () => {
    expect(startsWithPath("/tmp", () => true)).toBe(true);
    expect(startsWithPath("/tmp", nothingExists)).toBe(false);
  });

  it("never reads a bare slash or a word without one as a path", () => {
    expect(startsWithPath("/", () => true)).toBe(false);
    expect(startsWithPath("Users/me", () => true)).toBe(false);
  });
});
