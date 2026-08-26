import { describe, expect, test } from "bun:test";
import { maskSecret, maskSecretCaret } from "./mask-secret";

describe("maskSecret", () => {
  test("reveals the last 6 characters for keys of length 6 or more", () => {
    expect(maskSecret("c9706a74-71d7-4523-8044-29b01abff127")).toBe("***bff127");
    expect(maskSecret("sk-anthropic-ABCDEF1234WXYZ")).toBe("***34WXYZ");
    expect(maskSecret("abcdef")).toBe("***abcdef");
  });

  test("reveals only the last 2 characters when shorter than 6", () => {
    expect(maskSecret("abcde")).toBe("***de");
    expect(maskSecret("abcd")).toBe("***cd");
    expect(maskSecret("abc")).toBe("***bc");
  });

  test("masks the entire value when it is 1 or 2 characters", () => {
    expect(maskSecret("ab")).toBe("***");
    expect(maskSecret("a")).toBe("***");
    expect(maskSecret("ab")).not.toContain("a");
    expect(maskSecret("ab")).not.toContain("b");
  });

  test("returns empty string for empty input", () => {
    expect(maskSecret("")).toBe("");
  });

  test("never returns the full secret", () => {
    expect(maskSecret("c9706a74-71d7-4523-8044-29b01abff127")).not.toBe(
      "c9706a74-71d7-4523-8044-29b01abff127",
    );
    expect(maskSecret("short")).not.toBe("short");
    expect(maskSecret("xy")).not.toBe("xy");
  });

  test("honors an explicit reveal length for long secrets", () => {
    expect(maskSecret("c9706a74-71d7-4523-8044-29b01abff127", { reveal: 8 })).toBe("***1abff127");
  });
});

describe("maskSecretCaret", () => {
  test("maps a caret at the end of a long secret onto the revealed tail", () => {
    const value = "c9706a74-71d7-4523-8044-29b01abff127";
    expect(maskSecretCaret(value, value.length)).toBe("***bff127".length);
  });

  test("keeps a caret in the hidden prefix on the mask", () => {
    expect(maskSecretCaret("abcdefghij", 2)).toBe(3);
    expect(maskSecretCaret("abcdefghij", 0)).toBe(0);
  });
});
