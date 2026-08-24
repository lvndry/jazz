import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import { userInteractionTools } from "./user-interaction-tools";

const askUserQuestion = userInteractionTools.find((tool) => tool.name === "ask_user_question");

function harness(response: string) {
  return Layer.succeed(PresentationServiceTag, {
    requestUserInput: () => Effect.succeed(response),
  } as never);
}

async function ask(response: string): Promise<{ success: boolean; result: string }> {
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
    effect.pipe(Effect.provide(harness(response))) as Effect.Effect<
      { success: boolean; result: string },
      never,
      never
    >,
  );
}

describe("ask_user_question", () => {
  it("passes a real answer through", async () => {
    const outcome = await ask("next Tuesday at 3pm");
    expect(outcome.success).toBe(true);
    expect(outcome.result).toBe("User responded: next Tuesday at 3pm");
  });

  it("reports failure when there is nobody to ask", async () => {
    // Every non-interactive presentation answers with "".
    const outcome = await ask("");
    expect(outcome.success).toBe(false);
    expect(outcome.result).toContain("No answer was given");
    // The model must not read this as an answer it can act on.
    expect(outcome.result).not.toContain("User responded");
  });

  it("treats whitespace as no answer too", async () => {
    const outcome = await ask("   \n  ");
    expect(outcome.success).toBe(false);
    expect(outcome.result).toContain("No answer was given");
  });

  it("tells the model what to do instead of inventing one", async () => {
    const outcome = await ask("");
    expect(outcome.result).toContain("ask in your reply");
    expect(outcome.result).toContain("assumption");
  });
});
