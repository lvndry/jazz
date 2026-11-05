import { describe, expect, it } from "bun:test";
import { Cause, Effect, Layer, Option } from "effect";
import { isRunParkRequested } from "@/core/agent/run/park-signal";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import { narrowEffect } from "@/core/test-support/fakes";
import { userInteractionTools } from "./user-interaction";

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
  outcome?: string;
}> {
  const effect = narrowEffect<{ success: boolean; result: string }>(
    askUserQuestion!.execute(
      {
        question: "When is your appointment?",
        suggested_responses: [
          { value: "today", label: "Today" },
          { value: "tomorrow", label: "Tomorrow" },
        ],
      },
      { agentId: "a", conversationId: "c" },
    ),
  );
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
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
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

  it("gives every option a display label, defaulting to its value", async () => {
    let shown: ReadonlyArray<{ value: string; label?: string }> = [];
    const effect = narrowEffect<unknown>(
      askUserQuestion!.execute(
        {
          question: "Which?",
          suggested_responses: [{ value: "a" }, { value: "b", label: "B (Recommended)" }],
        },
        { agentId: "a", conversationId: "c" },
      ),
    );
    await Effect.runPromise(
      effect.pipe(
        Effect.provide(
          Layer.succeed(PresentationServiceTag, {
            requestUserInput: (request: { suggestions: typeof shown }) => {
              shown = request.suggestions;
              return Effect.succeed({ kind: "answered", response: "a" });
            },
          } as never),
        ),
      ) as Effect.Effect<unknown, never, never>,
    );
    expect(shown.map((option) => option.label)).toEqual(["a", "B (Recommended)"]);
    expect(shown.map((option) => option.value)).toEqual(["a", "b"]);
  });

  it("passes a real answer through", async () => {
    const result = await ask({ kind: "answered", response: "next Tuesday at 3pm" });
    expect(result.success).toBe(true);
    expect(result.result).toBe("User responded: next Tuesday at 3pm");
  });

  it("reports a refusal as a failed result, never as an answer", async () => {
    const result = await ask({ kind: "declined" });
    expect(result.success).toBe(false);
    expect(result.outcome).toBe("declined");
    expect(result.result).not.toContain("User responded");
    expect(result.result).not.toContain("today");
    expect(result.result).not.toContain("tomorrow");
  });

  it("returns the same result for a refusal live and on resume", async () => {
    const live = await ask({ kind: "declined" });
    const effect = narrowEffect<{ success: boolean; result: string }>(
      askUserQuestion!.execute(
        {
          question: "When is your appointment?",
          suggested_responses: [{ value: "today" }, { value: "tomorrow" }],
        },
        {
          agentId: "a",
          conversationId: "c",
          toolCallId: "call_5",
          resolvedUserInputs: new Map([["call_5", { kind: "declined" }]]),
        },
      ),
    );
    const resumed = await Effect.runPromise(
      effect.pipe(
        Effect.provide(
          Layer.succeed(PresentationServiceTag, {
            requestUserInput: () => Effect.die("must not prompt again once resolved"),
          } as never),
        ),
      ) as Effect.Effect<{ success: boolean; result: string }, never, never>,
    );
    expect(resumed).toEqual(live);
  });

  it("reports an absent human as a failed result distinct from a refusal", async () => {
    const unavailable = await ask({ kind: "unavailable" });
    const declined = await ask({ kind: "declined" });
    expect(unavailable.success).toBe(false);
    expect(unavailable.outcome).toBe("unavailable");
    expect(unavailable.outcome).not.toBe(declined.outcome);
    expect(unavailable.result).not.toContain("User responded");
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
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
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
    const effect = narrowEffect<{ success: boolean; result: string }>(
      askFilePicker!.execute(
        { message: "Pick the config file" },
        {
          agentId: "a",
          conversationId: "c",
          toolCallId: "call_3",
          resolvedFilePickers: new Map([
            ["call_3", { kind: "selected", path: "/tmp/config.json" }],
          ]),
        },
      ),
    );
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
    const effect = narrowEffect<{ success: boolean; result: string }>(
      askFilePicker!.execute(
        { message: "Pick the config file" },
        {
          agentId: "a",
          conversationId: "c",
          toolCallId: "call_4",
          resolvedFilePickers: new Map([["call_4", { kind: "cancelled" }]]),
        },
      ),
    );
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
