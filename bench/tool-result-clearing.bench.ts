// The cheapest rung of the context ladder, and the one that runs most often:
// before a turn goes out, `clearToolResults` walks the whole history, counts
// every tool message, and stubs the large stale ones. `context-window` covers
// the counting half of the ladder; this is the rewriting half.
//
// Both branches of the token counter are pinned, because the walk calls
// `countMessage` once per tool message and that is where its time goes:
// OpenAI-family models run a real BPE pass, everything else takes the ratio
// shortcut.
import { markdownReply } from "./corpus";
import { bench, report } from "./harness";
import {
  clearToolResults,
  toolResultsProtectFromIndex,
} from "../packages/core/src/agent/context/tool-result-clearing";
import type { ChatMessage } from "../packages/core/src/types/message";

const OPENAI_HINT = { provider: "openai", modelId: "gpt-4o" };
const ANTHROPIC_HINT = { provider: "anthropic", modelId: "claude-sonnet-4-5" };

const bigResult = markdownReply(4_000);

/**
 * A run's real shape: user turn, assistant turn that calls a tool, the tool's
 * result. Fresh objects per call — `countMessage` memoizes per object via
 * WeakMap, and history rewritten by a previous rung is all new objects.
 */
function toolHistory(cycles: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: "You are jazz." }];
  for (let index = 0; index < cycles; index += 1) {
    messages.push({ role: "user", content: `question ${String(index)}?` });
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: `call-${String(index)}`,
          type: "function",
          function: { name: "read_file", arguments: `{"path":"src/module-${String(index)}.ts"}` },
        },
      ],
    });
    messages.push({
      role: "tool",
      tool_call_id: `call-${String(index)}`,
      // Every third result is small enough to fall under the clear threshold,
      // so the walk pays the count and then skips — the common case.
      content: index % 3 === 0 ? "ok" : bigResult,
    });
  }
  return messages;
}

const retrievable = new Set(
  Array.from({ length: 200 }, (_unused, index) => `call-${String(index)}`),
);
const history200 = toolHistory(200);

const results = [
  bench("toolResultsProtectFromIndex, 200 cycles", () => {
    toolResultsProtectFromIndex(history200);
  }),
  bench(
    "clearToolResults 60 cycles, BPE (openai)",
    () => {
      const messages = toolHistory(60);
      clearToolResults(messages, {
        protectedFromIndex: toolResultsProtectFromIndex(messages),
        modelHint: OPENAI_HINT,
      });
    },
    { iterations: 40 },
  ),
  bench(
    "clearToolResults 200 cycles, BPE (openai)",
    () => {
      const messages = toolHistory(200);
      clearToolResults(messages, {
        protectedFromIndex: toolResultsProtectFromIndex(messages),
        modelHint: OPENAI_HINT,
      });
    },
    { iterations: 10, warmupIterations: 2 },
  ),
  bench(
    "clearToolResults 200 cycles, ratio (anthropic)",
    () => {
      const messages = toolHistory(200);
      clearToolResults(messages, {
        protectedFromIndex: toolResultsProtectFromIndex(messages),
        modelHint: ANTHROPIC_HINT,
      });
    },
    { iterations: 20 },
  ),
  // Offloaded bodies: same walk, but every stub names `retrieve_tool_result`.
  bench(
    "clearToolResults 200 cycles, retrievable ids",
    () => {
      const messages = toolHistory(200);
      clearToolResults(messages, {
        protectedFromIndex: toolResultsProtectFromIndex(messages),
        modelHint: ANTHROPIC_HINT,
        retrievableIds: retrievable,
      });
    },
    { iterations: 20 },
  ),
  // Nothing left to clear: the second pass over already-stubbed history, which
  // is what every turn after the first compaction actually runs.
  bench(
    "clearToolResults, already cleared (no-op pass)",
    () => {
      const messages = toolHistory(200).map((message) =>
        message.role === "tool" ? { ...message, cleared: true as const } : message,
      );
      clearToolResults(messages, {
        protectedFromIndex: toolResultsProtectFromIndex(messages),
        modelHint: ANTHROPIC_HINT,
      });
    },
    { iterations: 20 },
  ),
];

report("tool-result-clearing", results);
