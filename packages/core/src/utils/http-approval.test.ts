/** Regression cases for URL approval boundaries, including query overrides and lookalikes. */
import { describe, expect, it } from "bun:test";
import { checkConfigWrite } from "./config-schema";
import {
  describeHttpUrlPatternError,
  effectiveHttpUrl,
  httpToolIsApproved,
  httpUrlIsApproved,
} from "./http-approval";

describe("HTTP URL approvals", () => {
  it("matches normalized exact URLs including the effective query", () => {
    const args = {
      url: "https://EXAMPLE.com:443/data?x=old#section",
      query: { x: "new", count: 2 },
    };
    const url = effectiveHttpUrl("http_request", args);
    expect(url).toBe("https://example.com/data?x=new&count=2");
    expect(httpUrlIsApproved(url!, ["https://example.com/data?x=new&count=2"])).toBe(true);
    expect(httpUrlIsApproved(url!, ["https://example.com/data?x=old"])).toBe(false);
  });

  it("keeps path prefixes on their exact origin and below a path boundary", () => {
    const list = ["https://api.example.com/v1/*"];
    expect(httpUrlIsApproved("https://api.example.com/v1/items?q=data", list)).toBe(true);
    for (const url of [
      "https://api.example.com/v10/items",
      "https://api.example.com/v1/../admin",
      "https://api.example.com.evil.test/v1/items",
      "https://evil.test/v1/items",
      "http://api.example.com/v1/items",
      "https://api.example.com:444/v1/items",
    ])
      expect(httpUrlIsApproved(url, list)).toBe(false);
  });

  it("validates configured grants and removes the old settings", () => {
    expect(checkConfigWrite("network.httpApproval", "allow").ok).toBe(true);
    expect(checkConfigWrite("network.httpApproval", []).ok).toBe(true);
    expect(checkConfigWrite("network.httpApproval", ["http://127.0.0.1:8080/*"]).ok).toBe(true);
    for (const input of [
      "https://*.example.com/*",
      "https://example.com/x*",
      "file:///tmp/x",
      "https://user:pass@example.com/",
      "https://example.com/#x",
      "https://example.com/?x=1/*",
    ]) {
      expect(describeHttpUrlPatternError(input)).toBeDefined();
      expect(checkConfigWrite("network.httpApproval", [input]).ok).toBe(false);
    }
    expect(
      checkConfigWrite(
        "network.httpApproval",
        Array.from({ length: 65 }, () => "https://example.com/"),
      ).ok,
    ).toBe(false);
    expect(checkConfigWrite("network.trustedGetHosts", []).ok).toBe(false);
    expect(checkConfigWrite("network.taintedEgress", "allow").ok).toBe(false);
  });

  it("grants only one exact URL when a person approves a call", () => {
    const approved = "http://127.0.0.1:8080/request?q=1";
    expect(httpUrlIsApproved(approved, [], approved)).toBe(true);
    expect(httpUrlIsApproved("http://127.0.0.1:8080/request?q=2", [], approved)).toBe(false);
    expect(httpUrlIsApproved("http://localhost:8080/request?q=1", [], approved)).toBe(false);
  });

  it("scopes automatic HTTP authorization to the two built-in tools", () => {
    expect(
      httpToolIsApproved(
        "http_request",
        { method: "DELETE", url: "http://127.0.0.1/x" },
        undefined,
      ),
    ).toBe(true);
    expect(
      httpToolIsApproved("web_fetch", { url: "https://collector.example/?secret=x" }, undefined),
    ).toBe(true);
    expect(
      httpToolIsApproved("read_pdf", { url: "https://example.com/x.pdf" }, undefined),
    ).toBeUndefined();
    expect(
      httpToolIsApproved("http_request", { method: "POST", url: "https://example.com/" }, []),
    ).toBe(false);
  });
});
