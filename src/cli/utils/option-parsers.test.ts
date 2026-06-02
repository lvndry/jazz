import { describe, expect, it } from "bun:test";
import { parsePositiveInt } from "./option-parsers";

describe("parsePositiveInt", () => {
  const parse = parsePositiveInt("--timeout");

  it("parses a positive integer string", () => {
    expect(parse("5000")).toBe(5000);
    expect(parse("1")).toBe(1);
  });

  it("ignores trailing non-numeric characters like parseInt", () => {
    expect(parse("30s")).toBe(30);
  });

  it("throws on zero, negatives, and non-numeric input", () => {
    expect(() => parse("0")).toThrow('--timeout must be a positive integer (got "0").');
    expect(() => parse("-3")).toThrow("--timeout must be a positive integer");
    expect(() => parse("abc")).toThrow("--timeout must be a positive integer");
  });

  it("uses the provided label in the error message", () => {
    expect(() => parsePositiveInt("--max-iterations")("x")).toThrow(
      "--max-iterations must be a positive integer",
    );
  });
});
