// Compaction's prep step. Before any LLM call happens, `chunkForSummarizer`
// splits the history it is about to summarize into model-sized batches, and
// it does that by counting every message — so the cost is the token counter
// times the history length, paid on the turn a conversation runs out of
// window. The LLM call itself is out of scope here.
import { markdownReply } from "./corpus";
import { bench, report } from "./harness";
import { chunkForSummarizer } from "../packages/core/src/agent/context/summarizer";
import type { ChatMessage } from "../packages/core/src/types/message";

const OPENAI_HINT = { provider: "openai", modelId: "gpt-4o" };
const ANTHROPIC_HINT = { provider: "anthropic", modelId: "claude-sonnet-4-5" };

const toolResult = markdownReply(4_000);

// Fresh objects per call: compaction runs on history the ladder has already
// rewritten, so the counter's per-object memo starts cold.
function history(messageCount: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let index = 0; index < messageCount; index += 1) {
    messages.push({
      role: index % 2 === 0 ? "user" : "assistant",
      content: index % 5 === 4 ? toolResult : `message number ${String(index)}`,
    });
  }
  return messages;
}

const results = [
  bench(
    "chunkForSummarizer 500 messages, BPE (openai)",
    () => {
      chunkForSummarizer(history(500), 100_000, OPENAI_HINT);
    },
    { iterations: 20 },
  ),
  bench(
    "chunkForSummarizer 2000 messages, BPE (openai)",
    () => {
      chunkForSummarizer(history(2_000), 100_000, OPENAI_HINT);
    },
    { iterations: 10, warmupIterations: 2 },
  ),
  bench(
    "chunkForSummarizer 2000 messages, ratio (anthropic)",
    () => {
      chunkForSummarizer(history(2_000), 100_000, ANTHROPIC_HINT);
    },
    { iterations: 20 },
  ),
  // A small budget means many chunks: same counting work, more array churn,
  // and the recursive path the summarizer takes when one pass will not fit.
  bench(
    "chunkForSummarizer 2000 messages, 8k budget (many chunks)",
    () => {
      chunkForSummarizer(history(2_000), 8_000, ANTHROPIC_HINT);
    },
    { iterations: 20 },
  ),
];

report("summarizer-chunking", results);
