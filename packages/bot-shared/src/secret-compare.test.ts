import { describe, expect, test } from "bun:test";
import { secretsMatch } from "./secret-compare";

describe("secretsMatch", () => {
  test("matches only the exact secret", () => {
    expect(secretsMatch("s3cret", "s3cret")).toBe(true);
    expect(secretsMatch("s3cret", "s3cre")).toBe(false);
    expect(secretsMatch("s3cret", "s3cret ")).toBe(false);
  });

  test("an unset secret or a missing header never matches", () => {
    expect(secretsMatch("", "")).toBe(false);
    expect(secretsMatch("s3cret", null)).toBe(false);
    expect(secretsMatch("s3cret", undefined)).toBe(false);
  });
});
