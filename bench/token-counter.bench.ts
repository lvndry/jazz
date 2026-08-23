// Token counting runs per message, and the whole history is re-counted by the
// context ladder. OpenAI families pay for a real BPE pass; everything else
// takes the chars-per-token ratio shortcut — the gap is the interesting number.
import { markdownReply } from "./corpus";
import { bench, report } from "./harness";
import { TokenCounter } from "../src/core/agent/context/token-counter";
import type { ChatMessage } from "../src/core/types/message";

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

const results = [
  bench("countText short, BPE (openai)", () => {
    counter.countText(shortText, OPENAI_HINT);
  }),
  bench("countText short, ratio (anthropic)", () => {
    counter.countText(shortText, ANTHROPIC_HINT);
  }),
  bench(
    "countText 50KB, BPE (openai)",
    () => {
      counter.countText(toolResultText, OPENAI_HINT);
    },
    { iterations: 40 },
  ),
  bench("countText 50KB, ratio (anthropic)", () => {
    counter.countText(toolResultText, ANTHROPIC_HINT);
  }),
  // Fresh message objects each iteration: countMessage memoizes per object via
  // WeakMap, and the cold path is what the ladder pays on new history.
  bench(
    "countMessage cold x100, BPE (openai)",
    () => {
      const messages = freshMessages(100, shortText);
      for (const message of messages) {
        counter.countMessage(message, OPENAI_HINT);
      }
    },
    { iterations: 60 },
  ),
];

report("token-counter", results);
