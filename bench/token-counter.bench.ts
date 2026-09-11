// Token counting runs per message, and the whole history is re-counted by the
// context ladder. OpenAI families pay for a real BPE pass; everything else
// takes the chars-per-token ratio shortcut — the gap is the interesting number.
//
// `countText` caches BPE results by text, so text matters as much as size:
// the "unique text" rows are the tokenizer itself (what a message costs the
// first time anyone counts it) and the repeat rows are what the ladder pays
// to re-count history it has already seen. Both are real cadences — keep them
// apart, or a cache regression hides behind the hit rate.
import { markdownReply } from "./corpus";
import { bench, report } from "./harness";
import { TokenCounter } from "../packages/core/src/agent/context/token-counter";
import type { ChatMessage } from "../packages/core/src/types/message";

const OPENAI_HINT = { provider: "openai", modelId: "gpt-4o" };
const ANTHROPIC_HINT = { provider: "anthropic", modelId: "claude-sonnet-4-5" };

const shortText = "Sure — here is the plan, in three steps.";
const toolResultText = markdownReply(50_000);

function freshMessages(messageCount: number, content: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let index = 0; index < messageCount; index += 1) {
    messages.push({ role: index % 2 === 0 ? "user" : "assistant", content });
  }
  return messages;
}

const counter = new TokenCounter();

// One conversation's worth of distinct bodies, reused across iterations: the
// history a turn re-counts is the same history it counted last turn.
const calibrationHistory: ChatMessage[] = Array.from({ length: 500 }, (_unused, index) => ({
  role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
  content: index % 5 === 4 ? `${String(index)} ${markdownReply(2_000)}` : `${String(index)} reply`,
}));

const results = [
  bench("countText short, BPE (openai)", () => {
    counter.countText(shortText, OPENAI_HINT);
  }),
  bench("countText short, ratio (anthropic)", () => {
    counter.countText(shortText, ANTHROPIC_HINT);
  }),
  bench(
    "countText 50KB, BPE repeat text (openai)",
    () => {
      counter.countText(toolResultText, OPENAI_HINT);
    },
    { iterations: 40 },
  ),
  // Unique text per iteration: the tokenizer with no cache to fall back on.
  // A fresh counter each time, so nothing accumulates across iterations.
  bench(
    "countText 50KB, BPE unique text (openai)",
    (iteration) => {
      new TokenCounter().countText(`${String(iteration)} ${toolResultText}`, OPENAI_HINT);
    },
    { iterations: 40 },
  ),
  bench("countText 50KB, ratio (anthropic)", () => {
    counter.countText(toolResultText, ANTHROPIC_HINT);
  }),
  // Fresh message objects each iteration: countMessage memoizes per object via
  // WeakMap, so this misses that cache — but the text repeats, so it lands on
  // the BPE text cache. This is resume and post-compaction counting.
  bench(
    "countMessage x100, new objects / seen text (openai)",
    () => {
      const messages = freshMessages(100, shortText);
      for (const message of messages) {
        counter.countMessage(message, OPENAI_HINT);
      }
    },
    { iterations: 60 },
  ),
  // Neither cache can help: new objects carrying text nobody has counted.
  bench(
    "countMessage x100, fully cold (openai)",
    (iteration) => {
      const counterForRun = new TokenCounter();
      const messages = freshMessages(100, `${String(iteration)} ${shortText}`);
      for (const message of messages) {
        counterForRun.countMessage(message, OPENAI_HINT);
      }
    },
    { iterations: 60 },
  ),
  // `calibrate` runs after every response, and re-counts the history itself.
  // For a tokenizer-backed family the ratio it derives is never consulted, so
  // this is the per-turn floor on a long conversation — and the reason the
  // per-message memo is kept rather than discarded for those models.
  bench(
    "calibrate + recount, 500 messages, BPE (openai)",
    () => {
      counter.calibrate(120_000, calibrationHistory, OPENAI_HINT);
    },
    { iterations: 40 },
  ),
  bench(
    "calibrate + recount, 500 messages, ratio (anthropic)",
    () => {
      counter.calibrate(120_000, calibrationHistory, ANTHROPIC_HINT);
    },
    { iterations: 40 },
  ),
];

report("token-counter", results);
