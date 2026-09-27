import { AgentRunner } from "@jazz/core/agent/agent-runner";
import type { AgentRunnerOptions } from "@jazz/core/agent/types";
import { ToolRegistryTag, type Tool, type ToolRegistry } from "@jazz/core/interfaces/tool-registry";
import type { Agent } from "@jazz/core/types/agent";
import type { PeerConfig } from "@jazz/core/types/peer";
import { describe, expect, it, spyOn } from "bun:test";
import { Effect } from "effect";
import { extractClarificationQuestion, servePeerRequest } from "./serve";

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

describe("the run a peer's question starts", () => {
  const registry = {
    listTools: () => Effect.succeed(["web_search"]),
    getTool: () =>
      Effect.succeed({
        name: "web_search",
        riskLevel: "read-only",
        disclosure: "public",
        egress: false,
      } as unknown as Tool),
  } as unknown as ToolRegistry;

  async function runFor(peer: PeerConfig): Promise<AgentRunnerOptions | undefined> {
    let started: AgentRunnerOptions | undefined;
    const spy = spyOn(AgentRunner, "run").mockImplementation((options) => {
      started = options;
      return Effect.succeed({ content: "answered", conversationId: "peer-sam" });
    });
    try {
      await Effect.runPromise(
        servePeerRequest({
          peer,
          agent: { id: "a", name: "a", config: {} } as unknown as Agent,
          question: "what is in /Users/me/passport.pdf?",
        }).pipe(Effect.provideService(ToolRegistryTag, registry)) as Effect.Effect<unknown>,
      );
    } finally {
      spy.mockRestore();
    }
    return started;
  }

  it("names the peer as a remote caller, so it gets no operator context and no local files", async () => {
    const started = await runFor({ name: "sam", disclosure: "public" });

    expect(started?.remoteCaller).toEqual({ door: "peer", name: "sam" });
    expect(started?.ingestUserInputPaths).toBe(false);
  });

  it("carries the peer's budget", async () => {
    const started = await runFor({
      name: "sam",
      disclosure: "public",
      budget: { maxCostUSD: 0.05, maxTokens: 8_000 },
    });

    expect(started?.maxCostUSD).toBe(0.05);
    expect(started?.maxTokens).toBe(8_000);
    expect(started?.maxDurationMs).toBeUndefined();
  });
});
