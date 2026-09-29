import { InvalidToolInputError, TypeValidationError } from "ai";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { describeInvalidToolCall, SDK_STOP_CONDITIONS, toJazzToolCall } from "./tool-call-parts";

describe("toJazzToolCall", () => {
  it("serializes a valid call's input as its arguments", () => {
    const toolCall = toJazzToolCall({
      toolCallId: "call-1",
      toolName: "read_file",
      input: { path: "notes.md" },
    });

    expect(toolCall).toEqual({
      id: "call-1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"notes.md"}' },
    });
  });

  it("keeps an invalid call's raw text and carries the SDK's reason", () => {
    const toolCall = toJazzToolCall({
      toolCallId: "call-2",
      toolName: "read_file",
      input: '{"path": "notes.md"',
      invalid: true,
      error: new Error("JSON parsing failed: Unexpected end of JSON input\nat position 20"),
    });

    expect(toolCall.function.arguments).toBe('{"path": "notes.md"');
    expect(toolCall.invalidReason).toBe("JSON parsing failed: Unexpected end of JSON input");
  });

  it("names every field that did not match the tool's parameters", () => {
    const schema = z.object({
      todos: z.array(z.object({ content: z.string(), status: z.enum(["pending", "done"]) })),
    });
    const input = { todos: [{ task: "buy milk", status: "later" }] };
    const parsed = schema.safeParse(input);
    const error = new InvalidToolInputError({
      toolName: "manage_todos",
      toolInput: JSON.stringify(input),
      cause: new TypeValidationError({ value: input, cause: parsed.error }),
    });

    const reason = describeInvalidToolCall(error);

    expect(reason).toStartWith("the arguments did not match the tool's parameters (");
    expect(reason).toContain("todos[0].content: expected string, received undefined");
    expect(reason).toContain("todos[0].status:");
    expect(reason).not.toContain("\n");
  });

  it("formats symbol paths from Zod and rejects malformed issue paths", () => {
    const parsed = z
      .unknown()
      .superRefine((_value, context) => {
        context.addIssue({
          code: "custom",
          path: [Symbol("field")],
          message: "Invalid input: missing field",
        });
      })
      .safeParse({});
    expect(describeInvalidToolCall(parsed.error)).toContain("Symbol(field): missing field");
    const malformed = Object.assign(new Error("validation failed"), {
      issues: [{ path: [{}], message: "bad field" }],
    });
    expect(describeInvalidToolCall(malformed)).toBe("validation failed");
  });

  it("keeps Gemini's thought signature", () => {
    const toolCall = toJazzToolCall({
      toolCallId: "call-3",
      toolName: "web_search",
      input: {},
      providerMetadata: { google: { thoughtSignature: "sig" } },
    });

    expect(toolCall.thought_signature).toBe("sig");
  });
});

describe("SDK_STOP_CONDITIONS", () => {
  const stopsAfter = (toolCalls: ReadonlyArray<{ invalid?: boolean }>) =>
    SDK_STOP_CONDITIONS.some((condition) => condition({ steps: [{ toolCalls }] as never }));

  it("stops the SDK's loop on a step with an invalid call", () => {
    expect(stopsAfter([{ invalid: true }])).toBe(true);
  });

  it("leaves a step of valid calls to the step count", () => {
    expect(stopsAfter([{}])).toBe(false);
  });
});
