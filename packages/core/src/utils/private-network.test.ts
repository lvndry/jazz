import { describe, expect, it } from "bun:test";
import {
  classifyAddress,
  describePrivateHostEntryError,
  describeTrustedGetHostError,
  hostIsTrustedForGet,
  isIpLiteral,
  parsePrivateHostAllowlist,
} from "./private-network";

describe("classifyAddress", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["::1", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.10", "private"],
    ["169.254.169.254", "link-local"],
    ["100.64.0.1", "shared-address-space"],
    ["100.127.255.255", "shared-address-space"],
    ["0.0.0.0", "unspecified"],
    ["::", "unspecified"],
    ["::ffff:127.0.0.1", "ipv4-mapped"],
    ["::ffff:7f00:1", "ipv4-mapped"],
    ["::ffff:8.8.8.8", "ipv4-mapped"],
    ["[::ffff:7f00:1]", "ipv4-mapped"],
    ["fe80::1", "link-local"],
    ["fd00:ec2::254", "private"],
    ["fc00::1", "private"],
    ["ff02::1", "multicast"],
    ["224.0.0.251", "multicast"],
    ["255.255.255.255", "reserved"],
    ["192.0.2.1", "reserved"],
    ["2001:db8::1", "reserved"],
    ["64:ff9b::7f00:1", "loopback"],
    ["2002:7f00:1::", "loopback"],
    ["2002:c0a8:0101::1", "private"],
  ] as const)("classifies %s as %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it.each([
    "8.8.8.8",
    "93.184.215.14",
    "172.32.0.1",
    "100.128.0.1",
    "2606:4700::1111",
    "64:ff9b::808:808",
  ])("treats %s as public", (address) => {
    expect(classifyAddress(address)).toBe("public");
  });

  it("refuses anything that is not an address", () => {
    expect(classifyAddress("localhost")).toBe("reserved");
    expect(classifyAddress("999.1.1.1")).toBe("reserved");
  });

  it("sees the unusual IPv4 spellings as loopback once the URL parser has read them", () => {
    for (const spelling of ["2130706433", "0x7f000001", "0177.0.0.1", "127.1"]) {
      const hostname = new URL(`http://${spelling}/`).hostname;
      expect(isIpLiteral(hostname)).toBe(true);
      expect(classifyAddress(hostname)).toBe("loopback");
    }
  });
});

describe("parsePrivateHostAllowlist", () => {
  const allowlist = parsePrivateHostAllowlist([
    "homeassistant.local",
    "*.lan",
    "192.168.1.10",
    "10.0.0.0/8",
    "fd00::/8",
  ]);

  it("matches hostnames exactly, case-insensitively and ignoring the root dot", () => {
    expect(allowlist.allowsHostname("homeassistant.local")).toBe(true);
    expect(allowlist.allowsHostname("HomeAssistant.Local.")).toBe(true);
    expect(allowlist.allowsHostname("evil-homeassistant.local")).toBe(false);
  });

  it("matches wildcard suffixes below the suffix only", () => {
    expect(allowlist.allowsHostname("nas.lan")).toBe(true);
    expect(allowlist.allowsHostname("a.b.lan")).toBe(true);
    expect(allowlist.allowsHostname("lan")).toBe(false);
    expect(allowlist.allowsHostname("notlan")).toBe(false);
  });

  it("matches addresses and CIDR blocks per family", () => {
    expect(allowlist.allowsAddress("192.168.1.10")).toBe(true);
    expect(allowlist.allowsAddress("192.168.1.11")).toBe(false);
    expect(allowlist.allowsAddress("10.200.3.4")).toBe(true);
    expect(allowlist.allowsAddress("fd12::1")).toBe(true);
    expect(allowlist.allowsAddress("127.0.0.1")).toBe(false);
  });

  it("is empty when nothing is configured", () => {
    expect(parsePrivateHostAllowlist(undefined).isEmpty).toBe(true);
    expect(parsePrivateHostAllowlist([]).allowsAddress("127.0.0.1")).toBe(false);
  });
});

describe("describePrivateHostEntryError", () => {
  it.each(["homeassistant.local", "*.lan", "192.168.1.10", "192.168.1.0/24", "::1", "fd00::/8"])(
    "accepts %s",
    (entry) => {
      expect(describePrivateHostEntryError(entry)).toBeUndefined();
    },
  );

  it.each(["", "http://nas.lan", "192.168.1.0/33", "nas.lan/24", "*.", "two words"])(
    "rejects %j",
    (entry) => {
      expect(describePrivateHostEntryError(entry)).toBeString();
    },
  );
});

describe("trusted GET hosts", () => {
  it("accepts hostnames and wildcards and refuses addresses and blocks", () => {
    expect(describeTrustedGetHostError("eutils.ncbi.nlm.nih.gov")).toBeUndefined();
    expect(describeTrustedGetHostError("*.nih.gov")).toBeUndefined();
    expect(describeTrustedGetHostError("10.0.0.1")).toBeDefined();
    expect(describeTrustedGetHostError("10.0.0.0/8")).toBeDefined();
    expect(describeTrustedGetHostError("::1")).toBeDefined();
    expect(describeTrustedGetHostError("")).toBeDefined();
  });

  it("matches the URL's host, ignoring case and a trailing dot, over http and https only", () => {
    const entries = ["Example.COM"];
    expect(hostIsTrustedForGet("https://example.com./a?b=1", entries)).toBe(true);
    expect(hostIsTrustedForGet("http://EXAMPLE.com/", entries)).toBe(true);
    expect(hostIsTrustedForGet("ftp://example.com/", entries)).toBe(false);
    expect(hostIsTrustedForGet("not a url", entries)).toBe(false);
    expect(hostIsTrustedForGet("https://example.com/", undefined)).toBe(false);
    expect(hostIsTrustedForGet("https://a.example.com/", entries)).toBe(false);
  });
});
