import { describe, expect, test } from "bun:test";
import { displayedInput, maskSecret } from "./mask-secret";

describe("maskSecret", () => {
  test("keeps the secret's length and reveals its last 5 characters", () => {
    const key = "c9706a74-71d7-4523-8044-29b01abff127";
    expect(maskSecret(key)).toBe("*".repeat(key.length - 5) + "ff127");
    expect(maskSecret("abcdefghij")).toBe("*****fghij");
  });

  test("reveals only the last 2 characters when fewer than 10", () => {
    expect(maskSecret("abcdefghi")).toBe("*******hi");
    expect(maskSecret("abc")).toBe("*bc");
  });

  test("masks the entire value when it is 1 or 2 characters", () => {
    expect(maskSecret("ab")).toBe("**");
    expect(maskSecret("a")).toBe("*");
  });

  test("returns empty string for empty input", () => {
    expect(maskSecret("")).toBe("");
  });

  test("honors an explicit reveal length for long secrets", () => {
    const key = "c9706a74-71d7-4523-8044-29b01abff127";
    expect(maskSecret(key, { reveal: 8 })).toBe("*".repeat(key.length - 8) + "1abff127");
  });
});

describe("displayedInput", () => {
  test("conceal draws a bullet per character and nothing of the value", () => {
    expect(displayedInput("hunter22", 3, "conceal")).toEqual({ text: "••••••••", caret: 3 });
    expect(displayedInput("pa🔑ss", 4, "conceal")).toEqual({ text: "•••••", caret: 3 });
  });

  test("tail masks all but the last characters and leaves the caret in place", () => {
    expect(displayedInput("abcdefghijkl", 4, "tail")).toEqual({ text: "*******hijkl", caret: 4 });
  });

  test("plain shows the value as typed", () => {
    expect(displayedInput("hello", 2, "plain")).toEqual({ text: "hello", caret: 2 });
  });
});
