import type { ToolDisclosure } from "@jazz/core/interfaces/tool-registry";
import type { PeerTier } from "@jazz/core/types/peer";
import { describe, expect, it } from "bun:test";
import { allowedToolsForPeer, extractClarificationQuestion } from "./serve";

/** A slice of the real registry: one tool per interesting combination. */
const TOOLS: readonly {
  name: string;
  riskLevel: string;
  disclosure: ToolDisclosure;
}[] = [
  { name: "get_time", riskLevel: "read-only", disclosure: "internal" },
  { name: "web_search", riskLevel: "read-only", disclosure: "public" },
  { name: "ls", riskLevel: "read-only", disclosure: "internal" },
  { name: "read_file", riskLevel: "read-only", disclosure: "private" },
  { name: "view_memory", riskLevel: "read-only", disclosure: "private" },
  { name: "write_file", riskLevel: "high-risk", disclosure: "public" },
  { name: "execute_command", riskLevel: "unknown", disclosure: "private" },
  { name: "manage_memory", riskLevel: "low-risk", disclosure: "private" },
];

function allowed(tier: PeerTier, allow: readonly string[] = []): readonly string[] {
  return [...allowedToolsForPeer(tier, allow, TOOLS)].sort();
}

describe("what a tier permits among read-only tools", () => {
  it("gives a suspended peer nothing at all", () => {
    expect(allowed("none")).toEqual([]);
  });

  it("gives public only answers that are not about the operator", () => {
    expect(allowed("public")).toEqual(["web_search"]);
  });

  it("adds the shape of the machine at internal, but not its contents", () => {
    expect(allowed("internal")).toEqual(["get_time", "ls", "web_search"]);
    expect(allowed("internal")).not.toContain("read_file");
    expect(allowed("internal")).not.toContain("view_memory");
  });

  it("adds the operator's own material only at private", () => {
    expect(allowed("private")).toContain("read_file");
    expect(allowed("private")).toContain("view_memory");
  });

  it("is monotonic — a higher tier never permits less among read-only tools", () => {
    const order: readonly PeerTier[] = ["none", "public", "internal", "private"];
    for (let index = 1; index < order.length; index++) {
      const narrower = new Set(allowed(order[index - 1]!));
      for (const tool of narrower) {
        expect(allowed(order[index]!)).toContain(tool);
      }
    }
  });
});

describe("what a tier permits among riskier-than-read-only tools", () => {
  it("never permits an action absent an explicit grant, whatever the tier", () => {
    const actions = ["write_file", "execute_command", "manage_memory"];
    for (const tier of ["none", "public", "internal", "private"] as const) {
      for (const action of actions) {
        expect(allowed(tier)).not.toContain(action);
      }
    }
  });

  it("is capability, not disclosure, that gates a riskier tool: an explicit grant admits it regardless of tier", () => {
    // Even the narrowest non-suspended tier (public) gets a granted action — disclosure has
    // nothing to say about a tool that can act but reveals nothing.
    expect(allowed("public", ["write_file"])).toContain("write_file");
  });

  it("still withholds an ungranted action at the top tier", () => {
    expect(allowed("private", ["write_file"])).not.toContain("execute_command");
  });

  it("a suspended peer gets nothing, even with a standing grant", () => {
    // `disclosure: none` means no relationship at all — servePeerRequest refuses before this
    // function is ever consulted, but the function itself should not quietly admit a grant
    // for a peer with no tier.
    expect(allowed("none", ["write_file"])).toEqual([]);
  });
});

describe("recognizing a parked answer from toolResults", () => {
  it("finds nothing when request_clarification was never called", () => {
    expect(extractClarificationQuestion(undefined)).toBeUndefined();
    expect(extractClarificationQuestion({})).toBeUndefined();
    expect(extractClarificationQuestion({ some_other_tool: { ok: true } })).toBeUndefined();
  });

  it("extracts the question when request_clarification was the tool that ended the run", () => {
    expect(
      extractClarificationQuestion({ request_clarification: { question: "why do you ask?" } }),
    ).toBe("why do you ask?");
  });

  it("trims whitespace and rejects a blank question", () => {
    expect(extractClarificationQuestion({ request_clarification: { question: "  why?  " } })).toBe(
      "why?",
    );
    expect(
      extractClarificationQuestion({ request_clarification: { question: "   " } }),
    ).toBeUndefined();
  });

  it("is defensive about a malformed result shape", () => {
    expect(
      extractClarificationQuestion({ request_clarification: "not an object" }),
    ).toBeUndefined();
    expect(extractClarificationQuestion({ request_clarification: null })).toBeUndefined();
    expect(
      extractClarificationQuestion({ request_clarification: { question: 42 } }),
    ).toBeUndefined();
  });
});
