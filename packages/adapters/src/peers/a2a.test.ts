import { AgentCard as A2AAgentCard, SendMessageResponse } from "@a2a-js/sdk";
import type { ToolDisclosure } from "@jazz/core/interfaces/tool-registry";
import type { PeerConfig } from "@jazz/core/types/peer";
import { describe, expect, it } from "bun:test";
import {
  buildExtendedAgentCard,
  buildMessageResult,
  buildPublicAgentCard,
  normalizeProtocolVersion,
  parseA2ARequest,
} from "./a2a";

const ENDPOINT = "https://me.example/a2a";

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
    const card = buildPublicAgentCard("my-agent", ENDPOINT);
    expect(card.securitySchemes["peer-token"]?.httpAuthSecurityScheme.scheme).toBe("bearer");
    expect(card.securityRequirements[0]?.schemes["peer-token"]).toBeDefined();
    expect(card.capabilities.extendedAgentCard).toBe(true);
    // No peer-specific detail: this is the discovery document, not a grant.
    expect(card.skills).toHaveLength(1);
  });

  it("points callers at the address the card was fetched on", () => {
    const card = buildPublicAgentCard("my-agent", ENDPOINT);
    expect(card.supportedInterfaces).toEqual([
      { url: ENDPOINT, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ]);
  });

  it("promises no capability this door does not implement", () => {
    const card = buildPublicAgentCard("my-agent", ENDPOINT);
    expect(card.capabilities.streaming).toBe(false);
    expect(card.capabilities.pushNotifications).toBe(false);
    expect(card.defaultInputModes).toEqual(["text/plain"]);
    expect(card.defaultOutputModes).toEqual(["text/plain"]);
  });
});

/**
 * The card and the reply envelope are the two documents a client nobody here wrote has to
 * read before it will talk at all, so they are checked against the protocol's own parser
 * rather than against this repo's idea of the shape. A field renamed or nested wrongly reads
 * as an empty string or a dropped array on the far side, which is silent — the client simply
 * behaves as though the agent advertised nothing.
 */
describe("what a stock A2A client makes of what this door emits", () => {
  it("reads back every field of the card it needs to place a call", () => {
    const parsed = A2AAgentCard.fromJSON(buildPublicAgentCard("my-agent", ENDPOINT));
    expect(parsed.name).toBe("my-agent");
    expect(parsed.version).not.toBe("");
    expect(parsed.supportedInterfaces[0]?.url).toBe(ENDPOINT);
    expect(parsed.supportedInterfaces[0]?.protocolBinding).toBe("JSONRPC");
    expect(parsed.capabilities?.extendedAgentCard).toBe(true);
    expect(parsed.skills[0]?.id).toBe("answer_question");
    expect(parsed.securitySchemes["peer-token"]?.scheme?.$case).toBe("httpAuthSecurityScheme");
    expect(parsed.securityRequirements[0]?.schemes["peer-token"]).toBeDefined();
    expect(parsed.defaultInputModes).toEqual(["text/plain"]);
  });

  it("unwraps an answer as an agent message rather than an empty payload", () => {
    const result = buildMessageResult(1, "Thursday afternoon is clear.", "answered");
    const parsed = SendMessageResponse.fromJSON(result.result);
    expect(parsed.payload?.$case).toBe("message");
    const message = parsed.payload?.$case === "message" ? parsed.payload.value : undefined;
    expect(message?.parts[0]?.content).toEqual({
      $case: "text",
      value: "Thursday afternoon is clear.",
    });
    expect(message?.messageId).not.toBe("");
  });
});

describe("telling an answer apart from a refusal", () => {
  it("leaves a straight answer unmarked", () => {
    const result = buildMessageResult(1, "Thursday is clear.", "answered");
    expect((result.result as { message: { metadata?: unknown } }).message.metadata).toBeUndefined();
  });

  it("marks a refusal and a parked question so a caller cannot log either as a reply", () => {
    for (const outcome of ["refused", "parked"] as const) {
      const result = buildMessageResult(1, "no", outcome);
      const message = (result.result as { message: { metadata?: Record<string, string> } }).message;
      expect(message.metadata?.["ai.jazz/outcome"]).toBe(outcome);
    }
  });
});

describe("the extended agent card", () => {
  it("reflects exactly what this peer's tier admits", () => {
    const peer: PeerConfig = { name: "sam", disclosure: "public" };
    const card = buildExtendedAgentCard("my-agent", ENDPOINT, peer, TOOLS);
    expect(card.skills[0]?.tags).toEqual(["web_search"]);
  });

  it("adds a granted riskier tool without needing a wider tier", () => {
    const peer: PeerConfig = { name: "sam", disclosure: "public", allow: ["send_message"] };
    const card = buildExtendedAgentCard("my-agent", ENDPOINT, peer, TOOLS);
    expect(card.skills[0]?.tags).toContain("send_message");
    expect(card.skills[0]?.tags).toContain("web_search");
    expect(card.skills[0]?.tags).not.toContain("read_file");
  });

  it("reflects a suspended peer as reaching nothing", () => {
    const peer: PeerConfig = { name: "sam" };
    const card = buildExtendedAgentCard("my-agent", ENDPOINT, peer, TOOLS);
    expect(card.skills[0]?.tags).toEqual([]);
    expect(card.skills[0]?.description).toContain("suspended");
  });
});

describe("reducing an announced protocol version to what compatibility turns on", () => {
  it("assumes the version the protocol fixes for a caller that announces none", () => {
    expect(normalizeProtocolVersion(undefined)).toBe("0.3");
    expect(normalizeProtocolVersion(null)).toBe("0.3");
    expect(normalizeProtocolVersion("   ")).toBe("0.3");
  });

  it("keeps major and minor, and drops a patch that carries no wire difference", () => {
    expect(normalizeProtocolVersion("1.0")).toBe("1.0");
    expect(normalizeProtocolVersion(" 1.0 ")).toBe("1.0");
    expect(normalizeProtocolVersion("1.0.3")).toBe("1.0");
    expect(normalizeProtocolVersion("0.3")).toBe("0.3");
  });
});

describe("parsing a JSON-RPC request", () => {
  it("accepts a well-formed envelope", () => {
    const parsed = parseA2ARequest({ jsonrpc: "2.0", id: 1, method: "SendMessage" });
    expect(parsed?.method).toBe("SendMessage");
  });

  it("rejects anything missing jsonrpc, id, or method", () => {
    expect(parseA2ARequest({ id: 1, method: "SendMessage" })).toBeUndefined();
    expect(parseA2ARequest({ jsonrpc: "2.0", method: "SendMessage" })).toBeUndefined();
    expect(parseA2ARequest({ jsonrpc: "2.0", id: 1 })).toBeUndefined();
    expect(parseA2ARequest("not an object")).toBeUndefined();
    expect(parseA2ARequest(null)).toBeUndefined();
  });
});
