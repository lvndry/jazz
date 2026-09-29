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

/** One schema problem as the validator reports it: where, and what was wrong there. */
interface ValidationIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/** Validator messages open with this; it restates what the sentence around it already says. */
const REDUNDANT_ISSUE_PREFIX = /^Invalid input:\s*/i;

/** How far down a cause chain to look for the validator's issue list. */
const MAX_CAUSE_DEPTH = 5;

function isValidationIssue(value: unknown): value is ValidationIssue {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as { path?: unknown; message?: unknown };
  return (
    Array.isArray(record.path) &&
    record.path.every(
      (part: unknown) =>
        typeof part === "string" || typeof part === "number" || typeof part === "symbol",
    ) &&
    typeof record.message === "string"
  );
}

/** The schema issues somewhere down an error's cause chain, or none when it has no such list. */
function validationIssues(error: unknown): readonly ValidationIssue[] {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current !== null && typeof current === "object";
    depth += 1
  ) {
    const issues = (current as { issues?: unknown }).issues;
    if (Array.isArray(issues) && issues.length > 0 && issues.every(isValidationIssue)) {
      return issues;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return [];
}

/** `todos[0].content`: the field as a person would name it. */
function issuePath(path: readonly PropertyKey[]): string {
  return path
    .map((part, index) =>
      typeof part === "number"
        ? `[${String(part)}]`
        : index === 0
          ? String(part)
          : `.${String(part)}`,
    )
    .join("");
}

/**
 * Why the SDK marked a call invalid, in words the model can act on. A schema mismatch names
 * every field that was wrong, because the SDK's own message puts those on later lines and its
 * first line says only that validation failed.
 */
export function describeInvalidToolCall(error: unknown): string {
  if (error === undefined) {
    return "the arguments could not be parsed or did not match the tool's parameters.";
  }
  const issues = validationIssues(error);
  if (issues.length > 0) {
    const problems = issues.map((issue) => {
      const field = issuePath(issue.path);
      const message = issue.message.replace(REDUNDANT_ISSUE_PREFIX, "");
      return field.length > 0 ? `${field}: ${message}` : message;
    });
    return `the arguments did not match the tool's parameters (${problems.join("; ")})`;
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
