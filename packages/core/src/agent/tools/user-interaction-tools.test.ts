import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import { userInteractionTools } from "./user-interaction-tools";

const askUserQuestion = userInteractionTools.find((tool) => tool.name === "ask_user_question");

function harness(outcome: Record<string, unknown>) {
  return Layer.succeed(PresentationServiceTag, {
    requestUserInput: () => Effect.succeed(outcome),
  } as never);
}

async function ask(outcome: Record<string, unknown>): Promise<{
  success: boolean;
  result: string;
}> {
  const effect = askUserQuestion!.execute(
    {
      question: "When is your appointment?",
      suggested_responses: [
        { value: "today", label: "Today" },
        { value: "tomorrow", label: "Tomorrow" },
      ],
    },
    { agentId: "a", conversationId: "c" },
  ) as never as Effect.Effect<{ success: boolean; result: string }, never, never>;
  return Effect.runPromise(
    effect.pipe(Effect.provide(harness(outcome))) as Effect.Effect<
      { success: boolean; result: string },
      never,
      never
    >,
  );
}

describe("ask_user_question", () => {
  it("passes a real answer through", async () => {
    const result = await ask({ kind: "answered", response: "next Tuesday at 3pm" });
    expect(result.success).toBe(true);
    expect(result.result).toBe("User responded: next Tuesday at 3pm");
  });

  it("reports a refusal as the human's decision, not a gap to fill", async () => {
    const result = await ask({ kind: "declined" });
    expect(result.success).toBe(false);
    expect(result.result).toContain("declined to answer");
    expect(result.result).toContain("do not pick an answer for them");
    expect(result.result).not.toContain("User responded");
    expect(result.result).not.toContain("Nobody could be asked");
  });

  it("reports an absent human as something to decide around", async () => {
    const result = await ask({ kind: "unavailable" });
    expect(result.success).toBe(false);
    expect(result.result).toContain("Nobody could be asked");
    expect(result.result).toContain("state the assumption");
    expect(result.result).not.toContain("declined");
  });

  it("gives opposite guidance for the two failures", async () => {
    const declined = await ask({ kind: "declined" });
    const unavailable = await ask({ kind: "unavailable" });
    expect(declined.result).toContain("do not pick an answer");
    expect(unavailable.result).toContain("Decide yourself");
    expect(declined.result).not.toBe(unavailable.result);
  });
});
