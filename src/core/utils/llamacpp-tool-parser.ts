/**
 * llamacpp raw tool call parser
 *
 * llama-server's OpenAI-compatible endpoint sometimes leaks the model's native
 * tool-call tokens as plain text instead of converting them to structured JSON
 * function calls. This happens because each model family uses its own special-
 * token format and llama-server doesn't always perform the conversion reliably.
 *
 * This module parses the most common raw formats back into ToolCall objects so
 * that Jazz can still execute the tools even when the API response is malformed.
 *
 * Supported model formats:
 *   - Gemma (e.g. gemma-4-*-it):
 *       <|tool_call>call:NAME{key:<|"|>value<|"|>}<tool_call|>
 *   - Llama 3 / Mistral:
 *       [TOOL_CALLS] [{"name":"…","arguments":{…}}]
 *   - Qwen / generic XML-style:
 *       <tool_call>{"name":"…","arguments":{…}}</tool_call>
 */

import shortUUID from "short-uuid";
import type { ToolCall } from "@/core/types/tools";

export interface ParsedRawToolCalls {
  readonly toolCalls: ToolCall[];
  /** Text with all matched raw tool-call tokens stripped out. */
  readonly cleanText: string;
}

/**
 * Try to parse raw tool-call tokens that a llamacpp model emitted as plain text.
 * Returns `null` if no recognisable tool-call pattern was found so callers can
 * skip post-processing on the happy path.
 */
export function parseLlamaCppRawToolCalls(text: string): ParsedRawToolCalls | null {
  const toolCalls: ToolCall[] = [];
  let cleanText = text;

  // ── Gemma format ──────────────────────────────────────────────────────────
  // <|tool_call>call:TOOLNAME{key:<|"|>value<|"|>}<tool_call|>
  // The special token <|"|> (open) and <|"|> (close) both render the same way
  // but together represent a double-quote character inside argument values.
  const gemmaRe = /<\|tool_call>call:([\w-]+)\{([\s\S]*?)\}<tool_call\|>/g;
  cleanText = cleanText.replace(gemmaRe, (_match, toolName: string, rawArgs: string) => {
    // Replace Gemma's special quote tokens with actual double-quote characters.
    const normalised = rawArgs.replace(/<\|"\|>/g, '"');

    // Gemma emits unquoted keys (e.g. `query:"value"` instead of `"query":"value"`).
    // Quote any bare identifier keys before attempting JSON.parse.
    const quotedKeys = normalised.replace(/([a-zA-Z_][a-zA-Z0-9_]*)(\s*):/g, '"$1"$2:');

    const candidates = [`{${quotedKeys}}`, `{${normalised}}`, quotedKeys, normalised];
    for (const candidate of candidates) {
      try {
        const args = JSON.parse(candidate) as Record<string, unknown>;
        toolCalls.push(makeToolCall(toolName, args));
        return "";
      } catch {
        // try next candidate
      }
    }

    // Give up on this match; leave it in the text so the user can see it
    return _match;
  });

  // ── Llama 3 / Mistral format ───────────────────────────────────────────────
  // [TOOL_CALLS] [{"name":"…","arguments":{…}}, …]
  const llamaRe = /\[TOOL_CALLS\]\s*(\[[\s\S]*?\])/g;
  cleanText = cleanText.replace(llamaRe, (_match, jsonArray: string) => {
    try {
      const calls = JSON.parse(jsonArray) as Array<{
        name: string;
        arguments?: Record<string, unknown>;
      }>;
      for (const call of calls) {
        if (call.name) {
          toolCalls.push(makeToolCall(call.name, call.arguments ?? {}));
        }
      }
      return "";
    } catch {
      return _match;
    }
  });

  // ── Qwen / generic XML-style format ──────────────────────────────────────
  // <tool_call>{"name":"…","arguments":{…}}</tool_call>
  const qwenRe = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  cleanText = cleanText.replace(qwenRe, (_match, jsonObj: string) => {
    try {
      const call = JSON.parse(jsonObj) as {
        name: string;
        arguments?: Record<string, unknown>;
      };
      if (call.name) {
        toolCalls.push(makeToolCall(call.name, call.arguments ?? {}));
        return "";
      }
    } catch {
      // fall through
    }
    return _match;
  });

  if (toolCalls.length === 0) return null;

  return { toolCalls, cleanText: cleanText.trim() };
}

function makeToolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: shortUUID.generate(),
    type: "function" as const,
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}
