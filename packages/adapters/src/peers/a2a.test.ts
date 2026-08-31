import type { ToolDisclosure } from "@jazz/core/interfaces/tool-registry";
import type { PeerConfig } from "@jazz/core/types/peer";
import { describe, expect, it } from "bun:test";
import { buildExtendedAgentCard, buildPublicAgentCard, parseA2ARequest } from "./a2a";

const TOOLS: readonly {
  name: string;
  riskLevel: string;
  disclosure: ToolDisclosure;
}[] = [
  { name: "get_time", riskLevel: "read-only", disclosure: "internal" },
  { name: "web_search", riskLevel: "read-only", disclosure: "public" },
  { name: "read_file", riskLevel: "read-only", disclosure: "private" },
  { name: "send_message", riskLevel: "high-risk", disclosure: "public" },
];

describe("the public agent card", () => {
  it("is the same for every caller, and advertises the bearer scheme it actually accepts", () => {
    const card = buildPublicAgentCard("my-agent");
    expect(card.securitySchemes).toEqual([{ id: "peer-token", type: "http", scheme: "bearer" }]);
    expect(card.capabilities.extendedAgentCard).toBe(true);
    // No peer-specific detail: this is the discovery document, not a grant.
    expect(card.skills).toHaveLength(1);
  });
});

describe("the extended agent card", () => {
  it("reflects exactly what this peer's tier admits", () => {
    const peer: PeerConfig = { name: "sam", disclosure: "public" };
    const card = buildExtendedAgentCard("my-agent", peer, TOOLS);
    expect(card.skills[0]?.tags).toEqual(["web_search"]);
  });

  it("adds a granted riskier tool without needing a wider tier", () => {
    const peer: PeerConfig = { name: "sam", disclosure: "public", allow: ["send_message"] };
    const card = buildExtendedAgentCard("my-agent", peer, TOOLS);
    expect(card.skills[0]?.tags).toContain("send_message");
    expect(card.skills[0]?.tags).toContain("web_search");
    expect(card.skills[0]?.tags).not.toContain("read_file");
  });

  it("reflects a suspended peer as reaching nothing", () => {
    const peer: PeerConfig = { name: "sam" };
    const card = buildExtendedAgentCard("my-agent", peer, TOOLS);
    expect(card.skills[0]?.tags).toEqual([]);
    expect(card.skills[0]?.description).toContain("suspended");
  });
});

describe("parsing a JSON-RPC request", () => {
  it("accepts a well-formed envelope", () => {
    const parsed = parseA2ARequest({ jsonrpc: "2.0", id: 1, method: "a2a.SendMessage" });
    expect(parsed?.method).toBe("a2a.SendMessage");
  });

  it("rejects anything missing jsonrpc, id, or method", () => {
    expect(parseA2ARequest({ id: 1, method: "a2a.SendMessage" })).toBeUndefined();
    expect(parseA2ARequest({ jsonrpc: "2.0", method: "a2a.SendMessage" })).toBeUndefined();
    expect(parseA2ARequest({ jsonrpc: "2.0", id: 1 })).toBeUndefined();
    expect(parseA2ARequest("not an object")).toBeUndefined();
    expect(parseA2ARequest(null)).toBeUndefined();
  });
});
