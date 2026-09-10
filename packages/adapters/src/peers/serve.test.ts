import { describe, expect, it } from "bun:test";
import { extractClarificationQuestion } from "./serve";

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
