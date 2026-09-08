import { registerAllTools } from "@jazz/core/agent/tools/register-tools";
import { createToolRegistryLayer } from "@jazz/core/agent/tools/tool-registry";
import { ToolRegistryTag } from "@jazz/core/interfaces/tool-registry";
import type { PeerTier } from "@jazz/core/types/peer";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  allowedToolsForPeer,
  describeToolForPeer,
  extractClarificationQuestion,
  type PeerVisibleTool,
} from "./serve";

/**
 * Every globally-registered tool, described exactly as the peer door describes them.
 *
 * The hand-picked fixture below is the right shape for testing the rule, but it cannot
 * notice a real tool that slips past it. This walk is the same one `servePeerRequest` does,
 * so a tool added later is covered without anyone remembering to come back here.
 */
async function registeredTools(): Promise<readonly PeerVisibleTool[]> {
  const collect = Effect.gen(function* () {
    yield* registerAllTools();
    const registry = yield* ToolRegistryTag;
    const names = yield* registry.listTools();
    const described: PeerVisibleTool[] = [];
    for (const name of names) {
      described.push(describeToolForPeer(name, yield* registry.getTool(name)));
    }
    return described;
  });
  return Effect.runPromise(collect.pipe(Effect.provide(createToolRegistryLayer())));
}

/** A slice of the real registry: one tool per interesting combination. */
const TOOLS: readonly PeerVisibleTool[] = [
  { name: "get_time", riskLevel: "read-only", disclosure: "internal", egress: false },
  { name: "ls", riskLevel: "read-only", disclosure: "internal", egress: false },
  { name: "read_file", riskLevel: "read-only", disclosure: "private", egress: false },
  { name: "view_memory", riskLevel: "read-only", disclosure: "private", egress: false },
  { name: "write_file", riskLevel: "high-risk", disclosure: "public", egress: false },
  { name: "execute_command", riskLevel: "unknown", disclosure: "private", egress: false },
  { name: "manage_memory", riskLevel: "low-risk", disclosure: "private", egress: false },
  // Read-only and `public`, and still not something a tier hands over: the model writes the
  // query and it leaves the machine.
  { name: "web_search", riskLevel: "read-only", disclosure: "public", egress: true },
  // The same, at the other end of the disclosure scale, and the pairing that makes this
  // matter: at `private` a peer that also has `read_file` could name the address the bytes
  // go to.
  { name: "http_request", riskLevel: "read-only", disclosure: "private", egress: true },
];

function allowed(tier: PeerTier, allow: readonly string[] = []): readonly string[] {
  return [...allowedToolsForPeer(tier, allow, TOOLS)].sort();
}

describe("what a tier permits among read-only tools", () => {
  it("gives a suspended peer nothing at all", () => {
    expect(allowed("none")).toEqual([]);
  });

  it("gives public nothing that is about the operator, and nothing that sends", () => {
    // Empty rather than `["web_search"]`: the only read-only tools carrying `public`
    // disclosure are the ones that talk to the network, and a tier does not grant those.
    expect(allowed("public")).toEqual([]);
  });

  it("adds the shape of the machine at internal, but not its contents", () => {
    expect(allowed("internal")).toEqual(["get_time", "ls"]);
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

describe("what a tier permits among tools that send something off the machine", () => {
  it("never permits one absent an explicit grant, whatever the tier", () => {
    for (const tier of ["none", "public", "internal", "private"] as const) {
      expect(allowed(tier)).not.toContain("web_search");
      expect(allowed(tier)).not.toContain("http_request");
    }
  });

  it("admits one that is named in allow, at the tier that could otherwise disclose most", () => {
    expect(allowed("private", ["http_request"])).toContain("http_request");
  });

  it("admits one that is named in allow even at the narrowest live tier", () => {
    // Egress is gated like an action, not like a disclosure: `public` cannot be told the
    // operator's material, but it can be granted a specific tool that sends.
    expect(allowed("public", ["web_search"])).toContain("web_search");
  });

  it("a suspended peer gets nothing, even with a standing grant", () => {
    expect(allowed("none", ["http_request"])).toEqual([]);
  });
});

describe("what the real registry hands a peer", () => {
  /**
   * The exact tool set each tier grants with an empty `allow`, pinned.
   *
   * Pinned rather than spot-checked because the property that matters is negative — no tool
   * reaches a peer that shouldn't — and no assertion about today's tools can see tomorrow's.
   * A new tool that lands inside a tier fails this test, which is the moment to decide
   * whether a stranger's agent should have been given it. Update the list deliberately.
   *
   * `ask_user_question` and `ask_file_picker` appear at `private` and are withheld later,
   * by `withholdInteractiveTools` on the run itself — a separate control, since a peer
   * putting a prompt in front of the operator is its own problem.
   */
  const REACHABLE_BY_TIER: Readonly<Record<"public" | "internal" | "private", readonly string[]>> =
    {
      public: [],
      internal: [
        "cd",
        "context_info",
        "find",
        "get_time",
        "list_jobs",
        "list_triggers",
        "ls",
        "pdf_page_count",
        "pwd",
        "search_tools",
        "stat",
      ],
      private: [
        "ask_file_picker",
        "ask_user_question",
        "cd",
        "context_info",
        "find",
        "get_time",
        "grep",
        "list_jobs",
        "list_reminders",
        "list_todos",
        "list_triggers",
        "ls",
        "pdf_page_count",
        "pwd",
        "read_file",
        "read_pdf",
        "retrieve_tool_result",
        "search_tools",
        "stat",
        "summarize_context",
        "view_memory",
        "view_workspace",
      ],
    };

  it("hands each tier exactly the tools that list names, and nothing else", async () => {
    const tools = await registeredTools();
    for (const [tier, expected] of Object.entries(REACHABLE_BY_TIER)) {
      expect([...allowedToolsForPeer(tier as PeerTier, [], tools)].sort()).toEqual([...expected]);
    }
  });

  it("never lets a tier alone grant a tool that talks to the outside world", async () => {
    const tools = await registeredTools();
    const outbound = tools.filter((tool) => tool.egress).map((tool) => tool.name);

    // The registry really does carry some, or the assertion below passes vacuously.
    expect(outbound).toContain("http_request");
    expect(outbound).toContain("web_fetch");
    expect(outbound).toContain("web_search");

    for (const tier of ["public", "internal", "private"] as const) {
      const reachable = new Set(allowedToolsForPeer(tier, [], tools));
      for (const name of outbound) {
        expect(reachable.has(name), `${name} is reachable at ${tier} with an empty allow`).toBe(
          false,
        );
      }
    }
  });

  it("still hands over an outbound tool the operator named for this peer", async () => {
    const tools = await registeredTools();
    const reachable = allowedToolsForPeer("internal", ["web_fetch"], tools);
    expect(reachable).toContain("web_fetch");
    expect(reachable).not.toContain("http_request");
  });
});
