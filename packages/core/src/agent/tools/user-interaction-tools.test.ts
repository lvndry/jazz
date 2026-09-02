import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { isRunParkRequested } from "@/core/agent/run/park-signal";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import { userInteractionTools } from "./user-interaction-tools";

const askUserQuestion = userInteractionTools.find((tool) => tool.name === "ask_user_question");
const askFilePicker = userInteractionTools.find((tool) => tool.name === "ask_file_picker");

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
  it("parks an unattended run with the full question instead of inventing an answer", async () => {
    const effect = askUserQuestion!.execute(
      {
        question: "What is your budget?",
        suggested_responses: [{ value: "500" }, { value: "1000" }],
      },
      { agentId: "a", conversationId: "c", toolCallId: "call_1", parkWhenUnattended: true },
    );
    const exit = await Effect.runPromiseExit(
      effect.pipe(
        Effect.provide(
          Layer.succeed(PresentationServiceTag, {
            canPromptForApproval: () => false,
            requestUserInput: () => Effect.die("must not prompt in-process"),
          } as never),
        ),
      ) as Effect.Effect<unknown, unknown>,
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(isRunParkRequested(error)).toBe(true);
      if (isRunParkRequested(error)) {
        expect(error.pending).toMatchObject({
          kind: "question",
          toolCallId: "call_1",
          request: { question: "What is your budget?" },
        });
      }
    }
  });

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

describe("ask_file_picker", () => {
  it("parks an unattended run with the file picker request instead of auto-cancelling", async () => {
    const effect = askFilePicker!.execute(
      { message: "Pick the config file", extensions: ["json"] },
      { agentId: "a", conversationId: "c", toolCallId: "call_2", parkWhenUnattended: true },
    );
    const exit = await Effect.runPromiseExit(
      effect.pipe(
        Effect.provide(
          Layer.succeed(PresentationServiceTag, {
            canPromptForApproval: () => false,
            requestFilePicker: () => Effect.die("must not prompt in-process"),
          } as never),
        ),
      ) as Effect.Effect<unknown, unknown>,
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(isRunParkRequested(error)).toBe(true);
      if (isRunParkRequested(error)) {
        expect(error.pending).toMatchObject({
          kind: "file-picker",
          toolCallId: "call_2",
          request: { message: "Pick the config file" },
        });
      }
    }
  });

  it("uses a resolved selection from a resumed run instead of prompting again", async () => {
    const effect = askFilePicker!.execute(
      { message: "Pick the config file" },
      {
        agentId: "a",
        conversationId: "c",
        toolCallId: "call_3",
        resolvedFilePickers: new Map([["call_3", { kind: "selected", path: "/tmp/config.json" }]]),
      },
    ) as never as Effect.Effect<{ success: boolean; result: string }, never, never>;
    const result = await Effect.runPromise(
      effect.pipe(
        Effect.provide(
          Layer.succeed(PresentationServiceTag, {
            requestFilePicker: () => Effect.die("must not prompt again once resolved"),
          } as never),
        ),
      ) as Effect.Effect<{ success: boolean; result: string }, never, never>,
    );
    expect(result.success).toBe(true);
    expect(result.result).toBe("User selected: /tmp/config.json");
  });

  it("honors a resolved cancellation without prompting again", async () => {
    const effect = askFilePicker!.execute(
      { message: "Pick the config file" },
      {
        agentId: "a",
        conversationId: "c",
        toolCallId: "call_4",
        resolvedFilePickers: new Map([["call_4", { kind: "cancelled" }]]),
      },
    ) as never as Effect.Effect<{ success: boolean; result: string }, never, never>;
    const result = await Effect.runPromise(
      effect.pipe(
        Effect.provide(
          Layer.succeed(PresentationServiceTag, {
            requestFilePicker: () => Effect.die("must not prompt again once resolved"),
          } as never),
        ),
      ) as Effect.Effect<{ success: boolean; result: string }, never, never>,
    );
    expect(result.success).toBe(true);
    expect(result.result).toBe("User cancelled file selection");
  });
});
