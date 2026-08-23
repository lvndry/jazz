// The context ladder re-counts the whole history per message on long
// conversations — token counting amplified by history length.
import { markdownReply } from "./corpus";
import { bench, report } from "./harness";
import { ContextWindowManager } from "../src/core/agent/context/context-window-manager";
import type { ChatMessage } from "../src/core/types/message";

const manager = new ContextWindowManager({ maxTokens: 100_000 });

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

const short = history(100);
const medium = history(500);
const long = history(2_000);

const results = [
  bench("calculateTotalTokens, 100 messages", () => {
    manager.calculateTotalTokens(history(100));
  }),
  bench(
    "calculateTotalTokens, 500 messages",
    () => {
      manager.calculateTotalTokens(history(500));
    },
    { iterations: 60 },
  ),
  bench(
    "calculateTotalTokens, 2000 messages",
    () => {
      manager.calculateTotalTokens(history(2_000));
    },
    { iterations: 20 },
  ),
  // Reused arrays hit the per-message WeakMap memo — the steady-state cost of
  // re-checking an already-counted history every turn.
  bench("needsTrimming warm, 100 messages", () => {
    manager.needsTrimming(short);
  }),
  bench("needsTrimming warm, 500 messages", () => {
    manager.needsTrimming(medium);
  }),
  bench("needsTrimming warm, 2000 messages", () => {
    manager.needsTrimming(long);
  }),
];

report("context-window", results);
