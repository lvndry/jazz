import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { ChatMessage } from "@/core/types/message";
import type { CompactToolsInput, CompactToolsOutcome } from "@/core/types/plugin";
import { reduceToolResultsWithJev } from "./jev-tool-clearing";
import type { ModelHint, TokenCounter } from "./token-counter";

const modelHint: ModelHint = { provider: "anthropic", modelId: "test" };
// Every message counts as well over MIN_CLEARABLE_RESULT_TOKENS so both tool results qualify.
const fatCounter: TokenCounter = {
  countMessage: () => 1_000,
  countMessages: () => 1_000,
};

function transcript(): ChatMessage[] {
  return [
    { role: "system", content: "system" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "t0", type: "function", function: { name: "Read", arguments: "{}" } },
        { id: "t1", type: "function", function: { name: "Grep", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "t0", content: "A".repeat(2_000) },
    { role: "tool", tool_call_id: "t1", content: "B".repeat(2_000) },
    { role: "user", content: "recent, protected" },
  ];
}

const answeredWith = (
  decisions: CompactToolsOutcome extends { decisions: infer D } ? D : never,
): ((input: CompactToolsInput) => Effect.Effect<CompactToolsOutcome>) => {
  return () => Effect.succeed({ status: "answered", decisions });
};

describe("reduceToolResultsWithJev", () => {
  it("drops and truncates by decision, replacing content but never removing messages", async () => {
    const messages = transcript();
    const outcome = await Effect.runPromise(
      reduceToolResultsWithJev(messages, {
        protectedFromIndex: 4,
        goal: "refactor",
        modelHint,
        tokenCounter: fatCounter,
        decide: answeredWith([
          { id: "t0", action: "drop" },
          { id: "t1", action: "truncate" },
        ]),
      }),
    );

    expect(outcome.answered).toBe(true);
    expect(outcome.clearedCount).toBe(2);
    // Same number of messages, and both tool results keep their tool_call_id (pairing intact).
    expect(outcome.messages).toHaveLength(messages.length);
    expect(outcome.messages[2]?.tool_call_id).toBe("t0");
    expect(outcome.messages[3]?.tool_call_id).toBe("t1");
    // Dropped -> a "cleared / re-run" placeholder; truncated -> a "truncated" note. Neither verbatim.
    expect(String(outcome.messages[2]?.content)).toContain("cleared");
    expect(String(outcome.messages[3]?.content)).toContain("truncated");
    expect(String(outcome.messages[2]?.content).length).toBeLessThan(2_000);
  });

  it("leaves a result untouched when the decision is keep", async () => {
    const messages = transcript();
    const outcome = await Effect.runPromise(
      reduceToolResultsWithJev(messages, {
        protectedFromIndex: 4,
        goal: "refactor",
        modelHint,
        tokenCounter: fatCounter,
        decide: answeredWith([
          { id: "t0", action: "keep" },
          { id: "t1", action: "keep" },
        ]),
      }),
    );
    expect(outcome.clearedCount).toBe(0);
    expect(outcome.messages[2]?.content).toBe("A".repeat(2_000));
  });

  it("reports answered=false when the provider abstains, so the caller falls back", async () => {
    const messages = transcript();
    const outcome = await Effect.runPromise(
      reduceToolResultsWithJev(messages, {
        protectedFromIndex: 4,
        goal: "refactor",
        modelHint,
        tokenCounter: fatCounter,
        decide: () => Effect.succeed({ status: "abstained", reason: "provider unavailable" }),
      }),
    );
    expect(outcome.answered).toBe(false);
    expect(outcome.clearedCount).toBe(0);
    expect(outcome.messages).toBe(messages);
  });
});
