import { describe, expect, it } from "bun:test";
import { isHomeOrAncestor } from "./markdown-index";

describe("isHomeOrAncestor", () => {
  const home = "/Users/alice";

  it("flags the home directory itself", () => {
    expect(isHomeOrAncestor("/Users/alice", home)).toBe(true);
    expect(isHomeOrAncestor("/Users/alice/", home)).toBe(true);
  });

  it("flags directories above home, since scanning them still walks home", () => {
    expect(isHomeOrAncestor("/Users", home)).toBe(true);
    expect(isHomeOrAncestor("/", home)).toBe(true);
  });

  it("allows projects inside home", () => {
    expect(isHomeOrAncestor("/Users/alice/github/jazz", home)).toBe(false);
  });

  it("allows unrelated directories and lookalike prefixes", () => {
    expect(isHomeOrAncestor("/tmp/project", home)).toBe(false);
    expect(isHomeOrAncestor("/Users/alice2", home)).toBe(false);
  });
});
