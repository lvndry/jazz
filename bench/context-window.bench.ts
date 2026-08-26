// The context ladder re-counts the whole history per turn, and compaction /
// trimming recreate message objects — so the fresh-object cost is what a long
// conversation actually pays. Both pricing branches are pinned: OpenAI-family
// models run the real BPE tokenizer, everything else takes the ratio shortcut.
import { markdownReply } from "./corpus";
import { bench, report } from "./harness";
import { ContextWindowManager } from "../packages/core/src/agent/context/context-window-manager";
import type { ChatMessage } from "../packages/core/src/types/message";

const bpeManager = new ContextWindowManager({
  maxTokens: 100_000,
  modelHint: { provider: "openai", modelId: "gpt-4o" },
});
const ratioManager = new ContextWindowManager({
  maxTokens: 100_000,
  modelHint: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
});

function history(messageCount: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let index = 0; index < messageCount; index += 1) {
    messages.push({
      role: index % 2 === 0 ? "user" : "assistant",
      content: index % 5 === 4 ? markdownReply(4_000) : `message number ${String(index)}`,
    });
  }
  return messages;
}

const results = [
  bench(
    "calculateTotalTokens fresh 500, BPE (openai)",
    () => {
      bpeManager.calculateTotalTokens(history(500));
    },
    { iterations: 40 },
  ),
  bench(
    "calculateTotalTokens fresh 2000, BPE (openai)",
    () => {
      bpeManager.calculateTotalTokens(history(2_000));
    },
    { iterations: 10, warmupIterations: 2 },
  ),
  bench(
    "calculateTotalTokens fresh 2000, ratio (anthropic)",
    () => {
      ratioManager.calculateTotalTokens(history(2_000));
    },
    { iterations: 20 },
  ),
];

report("context-window", results);
