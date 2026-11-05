import { describe, expect, it } from "bun:test";
import { autoDetachPolicyFor, defaultAutoDetachPolicy } from "./auto-detach";

describe("autoDetachPolicyFor", () => {
  it("gives an attended chat run the policy", () => {
    expect(
      autoDetachPolicyFor({ attended: true, receivesLateResults: true, internal: false }),
    ).toBe(defaultAutoDetachPolicy);
  });

  it("keeps the foreground wait for an unattended run", () => {
    expect(
      autoDetachPolicyFor({ attended: false, receivesLateResults: true, internal: false }),
    ).toBeUndefined();
  });

  it("keeps the foreground wait when nothing delivers a late result", () => {
    expect(
      autoDetachPolicyFor({ attended: true, receivesLateResults: false, internal: false }),
    ).toBeUndefined();
  });

  it("keeps the foreground wait for a sub-agent", () => {
    expect(
      autoDetachPolicyFor({ attended: true, receivesLateResults: true, internal: true }),
    ).toBeUndefined();
  });
});
