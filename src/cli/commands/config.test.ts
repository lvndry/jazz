import { describe, expect, it } from "bun:test";
import { coerceConfigValue } from "./config";

describe("coerceConfigValue", () => {
  it("coerces 'true' to boolean true", () => {
    expect(coerceConfigValue("true")).toBe(true);
  });

  it("coerces 'false' to boolean false", () => {
    expect(coerceConfigValue("false")).toBe(false);
  });

  it("leaves other strings unchanged", () => {
    expect(coerceConfigValue("hello")).toBe("hello");
    expect(coerceConfigValue("")).toBe("");
    expect(coerceConfigValue("123")).toBe("123");
  });
});
