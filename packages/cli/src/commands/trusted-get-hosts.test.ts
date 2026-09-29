import { describe, expect, it } from "bun:test";
import { addTrustedGetHost, removeTrustedGetHost } from "./trusted-get-hosts";

describe("addTrustedGetHost", () => {
  it("adds a hostname or wildcard, trimmed and lowercased", () => {
    expect(addTrustedGetHost([], " EUtils.NCBI.nlm.nih.gov ")).toEqual({
      kind: "added",
      hosts: ["eutils.ncbi.nlm.nih.gov"],
    });
    expect(addTrustedGetHost(["a.example"], "*.wikipedia.org")).toEqual({
      kind: "added",
      hosts: ["a.example", "*.wikipedia.org"],
    });
  });

  it("refuses an empty entry, an address, a URL, a duplicate and a full list", () => {
    expect(addTrustedGetHost([], "  ").kind).toBe("invalid");
    expect(addTrustedGetHost([], "10.0.0.1").kind).toBe("invalid");
    expect(addTrustedGetHost([], "https://example.com").kind).toBe("invalid");
    expect(addTrustedGetHost(["a.example"], "A.example")).toEqual({
      kind: "invalid",
      message: "a.example is already on the list.",
    });
    const full = Array.from({ length: 64 }, (_unused, index) => `host-${String(index)}.example`);
    expect(addTrustedGetHost(full, "one-more.example").kind).toBe("invalid");
  });
});

describe("removeTrustedGetHost", () => {
  it("removes only that entry", () => {
    expect(removeTrustedGetHost(["a.example", "*.b.example"], "a.example")).toEqual([
      "*.b.example",
    ]);
  });
});
