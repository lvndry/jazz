import { describe, expect, it } from "bun:test";
import { SDK_STOP_CONDITIONS, toJazzToolCall } from "./tool-call-parts";

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
