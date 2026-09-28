import { describe, expect, it } from "bun:test";
import { isRetryableAnswerFailure, judgeAnswer, ranTools } from "./answer-outcome";

describe("judgeAnswer", () => {
  it("accepts a normal answer", () => {
    expect(judgeAnswer({ content: "PONG", finishReason: "stop" })).toEqual({
      kind: "answered",
      truncated: false,
    });
  });

  it("fails an empty zero-token completion", () => {
    const verdict = judgeAnswer({ content: "", finishReason: "stop", emptyCompletion: true });

    expect(verdict.kind).toBe("failed");
    expect(verdict.kind === "failed" && verdict.code).toBe("empty_response");
  });

  it("fails a non-stop finish with no content", () => {
    for (const finishReason of ["length", "other", "unknown", "error", "tool-calls"] as const) {
      const verdict = judgeAnswer({ content: "  ", finishReason });

      expect(verdict.kind === "failed" && verdict.code).toBe("no_answer");
      expect(verdict.kind === "failed" && verdict.message).toContain(finishReason);
    }
  });

  it("fails a content-filtered answer even when some text came through", () => {
    const verdict = judgeAnswer({ content: "partial", finishReason: "content-filter" });

    expect(verdict.kind === "failed" && verdict.code).toBe("content_filtered");
  });

  it("keeps a cut-off answer but marks it truncated", () => {
    expect(judgeAnswer({ content: "half an answ", finishReason: "length" })).toEqual({
      kind: "answered",
      truncated: true,
    });
  });

  it("accepts an answer made only of files", () => {
    const verdict = judgeAnswer({
      content: "",
      finishReason: "stop",
      emptyCompletion: true,
      artifacts: [
        {
          kind: "pdf",
          path: "/tmp/report.pdf",
          mediaType: "application/pdf",
          tool: "create_pdf",
          source: "rendered",
        },
      ],
    });

    expect(verdict.kind).toBe("answered");
  });

  it("leaves runs stopped by a limit or the user to their own flags", () => {
    for (const flag of [
      "interrupted",
      "iterationLimited",
      "costCapped",
      "tokenCapped",
      "durationCapped",
    ] as const) {
      expect(
        judgeAnswer({ content: "", finishReason: "unknown", emptyCompletion: true, [flag]: true })
          .kind,
      ).toBe("answered");
    }
  });
});

describe("isRetryableAnswerFailure", () => {
  it("retries empty and unanswered runs, never a content filter", () => {
    expect(isRetryableAnswerFailure("empty_response")).toBe(true);
    expect(isRetryableAnswerFailure("no_answer")).toBe(true);
    expect(isRetryableAnswerFailure("content_filtered")).toBe(false);
  });
});

describe("ranTools", () => {
  it("is true only when the run called a tool", () => {
    expect(ranTools({})).toBe(false);
    expect(ranTools({ toolCalls: [] })).toBe(false);
    expect(
      ranTools({
        toolCalls: [
          { id: "call-1", type: "function", function: { name: "send_email", arguments: "{}" } },
        ],
      }),
    ).toBe(true);
  });
});
