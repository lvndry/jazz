import { describe, expect, it } from "bun:test";
import { openBrowser } from "./loopback";

describe("openBrowser", () => {
  it("refuses every scheme outside http and https before spawning anything", () => {
    for (const url of [
      "file:///etc/passwd",
      "smb://attacker.example/share",
      "javascript:alert(1)",
      "vscode://open?file=/tmp/x",
      "mailto:someone@example.com",
      "not a url",
      "",
    ]) {
      expect(openBrowser(url)).toBe(false);
    }
  });

  it("refuses a scheme the caller did not allow", () => {
    expect(openBrowser("mailto:someone@example.com", new Set(["https:"]))).toBe(false);
  });
});
