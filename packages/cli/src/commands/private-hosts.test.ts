import { describe, expect, it } from "bun:test";
import { addPrivateHost, removePrivateHost } from "./private-hosts";

describe("addPrivateHost", () => {
  it("adds a hostname, wildcard, address or CIDR block, trimmed", () => {
    expect(addPrivateHost([], " homeassistant.local ")).toEqual({
      kind: "added",
      hosts: ["homeassistant.local"],
    });
    expect(addPrivateHost(["*.lan"], "192.168.1.0/24")).toEqual({
      kind: "added",
      hosts: ["*.lan", "192.168.1.0/24"],
    });
  });

  it("refuses an empty entry, a URL, a duplicate and a full list", () => {
    expect(addPrivateHost([], "  ").kind).toBe("invalid");
    expect(addPrivateHost([], "http://nas.lan").kind).toBe("invalid");
    expect(addPrivateHost(["nas.lan"], "nas.lan")).toEqual({
      kind: "invalid",
      message: "nas.lan is already on the list.",
    });
    const full = Array.from({ length: 64 }, (_unused, index) => `host-${String(index)}.lan`);
    expect(addPrivateHost(full, "one-more.lan").kind).toBe("invalid");
  });
});

describe("removePrivateHost", () => {
  it("removes only that entry", () => {
    expect(removePrivateHost(["a.lan", "10.0.0.2", "b.lan"], "10.0.0.2")).toEqual([
      "a.lan",
      "b.lan",
    ]);
  });
});
