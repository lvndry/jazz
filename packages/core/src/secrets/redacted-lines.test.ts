import { describe, expect, it } from "bun:test";
import { redactLines } from "./redacted-lines";

const PRIVATE_KEY_LINES = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAsecretbodyline1",
  "c2VjcmV0Ym9keWxpbmUy",
  "-----END RSA PRIVATE KEY-----",
];

describe("redactLines", () => {
  it("returns the lines as they are when nothing redacts", () => {
    const lines = ["one", "two"];
    const view = redactLines(lines, []);
    expect(view.lines).toEqual(lines);
    expect(view.secretLineIndexes.size).toBe(0);
  });

  it("keeps one entry per original line and marks the secret ones", () => {
    const view = redactLines(["DEBUG=1", "DB_PASSWORD=hunter2hunter2", "PORT=3000"], []);
    expect(view.lines).toEqual(["DEBUG=1", "DB_PASSWORD=[redacted:DB_PASSWORD]", "PORT=3000"]);
    expect([...view.secretLineIndexes]).toEqual([1]);
  });

  it("recognizes a private key block with its whole context and marks every line of it", () => {
    const view = redactLines(["before", ...PRIVATE_KEY_LINES, "after"], []);
    expect(view.lines).toHaveLength(PRIVATE_KEY_LINES.length + 2);
    expect(view.lines[0]).toBe("before");
    expect(view.lines.at(-1)).toBe("after");
    for (let index = 1; index <= PRIVATE_KEY_LINES.length; index++) {
      expect(view.lines[index]).toBe("[redacted:private-key]");
      expect(view.secretLineIndexes.has(index)).toBe(true);
    }
    expect(view.lines.join("\n")).not.toContain("secretbody");
  });

  it("replaces a known value exactly, wherever it sits in a line", () => {
    const view = redactLines(
      ["token is zq9-known-value-77 here"],
      [{ name: "llm.test.api_key", value: "zq9-known-value-77" }],
    );
    expect(view.lines).toEqual(["token is [redacted:llm.test.api_key] here"]);
  });
});
