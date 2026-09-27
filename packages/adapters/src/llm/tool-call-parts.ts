/**
 * Maps a tool call from the AI SDK (a streamed `tool-call` part or a `generateText` result
 * entry) to Jazz's `ToolCall`. Both completion paths use it, so they agree on how arguments are
 * serialized, which provider metadata survives, and how an invalid call is marked.
 */
import { AI_SDK_MAX_STEPS } from "@jazz/core/constants/agent";
import type { ToolCall } from "@jazz/core/types/tools";
import { toError } from "@jazz/core/utils/errors";
import { stepCountIs, type StopCondition, type ToolSet } from "ai";

/** The fields of an AI SDK tool call this mapping reads. */
export interface SdkToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly invalid?: boolean | undefined;
  readonly error?: unknown;
  readonly providerMetadata?: unknown;
}

/** Why the SDK marked a call invalid, as one line the model can act on. */
function describeInvalidToolCall(error: unknown): string {
  if (error === undefined) {
    return "the arguments could not be parsed or did not match the tool's parameters.";
  }
  return toError(error).message.split("\n")[0] ?? "the arguments could not be parsed.";
}

/**
 * Jazz's view of one SDK tool call. For an invalid call the SDK's `input` is the raw text the
 * model produced, which is kept as-is so the transcript shows what was actually sent, and the
 * SDK's error becomes `invalidReason` so the executor answers it instead of running the tool.
 */
export function toJazzToolCall(sdkToolCall: SdkToolCall): ToolCall {
  const rawInput = sdkToolCall.input;
  const toolCall: ToolCall = {
    id: sdkToolCall.toolCallId,
    type: "function",
    function: {
      name: sdkToolCall.toolName,
      arguments:
        sdkToolCall.invalid === true && typeof rawInput === "string"
          ? rawInput
          : JSON.stringify(rawInput ?? {}),
    },
  };

  const googleMetadata = (
    sdkToolCall.providerMetadata as { google?: { thoughtSignature?: unknown } } | undefined
  )?.google;
  if (typeof googleMetadata?.thoughtSignature === "string" && googleMetadata.thoughtSignature) {
    toolCall.thought_signature = googleMetadata.thoughtSignature;
  }

  if (sdkToolCall.invalid === true) {
    toolCall.invalidReason = describeInvalidToolCall(sdkToolCall.error);
  }

  return toolCall;
}

/**
 * When the SDK's own step loop stops. Jazz's tools carry no `execute`, so a step with a valid
 * call already ends the loop. A step whose calls are all invalid does not: the SDK answers
 * them itself and asks the model again, a turn Jazz's transcript never sees. Stopping on any
 * invalid call hands it to the executor, which reports the error in the open.
 */
export const SDK_STOP_CONDITIONS: Array<StopCondition<ToolSet>> = [
  stepCountIs(AI_SDK_MAX_STEPS),
  ({ steps }) => steps.at(-1)?.toolCalls.some((toolCall) => toolCall.invalid === true) ?? false,
];
