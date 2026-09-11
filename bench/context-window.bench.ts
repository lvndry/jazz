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

/**
 * `salt` makes every message body unique, which decides which caches can
 * help: the default (unsalted) history is text the counter has seen before,
 * the salted one is text nobody has counted yet.
 */
function history(messageCount: number, salt = ""): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let index = 0; index < messageCount; index += 1) {
    messages.push({
      role: index % 2 === 0 ? "user" : "assistant",
      // The salt varies per message, not just per call: a real history is
      // 2000 distinct bodies, so a fixture that repeats one body would let a
      // text cache answer 399 of every 400 counts.
      content:
        index % 5 === 4
          ? `${salt}${String(index)} ${markdownReply(4_000)}`
          : `${salt}message number ${String(index)}`,
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
  // Every body unique and a fresh manager, so no cache applies: the whole
  // 2000-message history tokenized from scratch, which is the worst case a
  // resume can hit (and the number the BPE text cache cannot improve).
  bench(
    "calculateTotalTokens 2000 uncacheable, BPE (openai)",
    (iteration) => {
      new ContextWindowManager({
        maxTokens: 100_000,
        modelHint: { provider: "openai", modelId: "gpt-4o" },
      }).calculateTotalTokens(history(2_000, `${String(iteration)} `));
    },
    { iterations: 10, warmupIterations: 2 },
  ),
];

report("context-window", results);
