// Session resume (--continue) parses and reduces the whole JSONL log before
// the first prompt renders — this is the startup tax of a long-lived session.
import { PROSE_PARAGRAPH } from "./corpus";
import { bench, report } from "./harness";
import {
  parseConversationLog,
  reduceConversationLog,
} from "../packages/adapters/src/history/conversation-log";

function logContent(eventCount: number): string {
  const lines: string[] = [
    JSON.stringify({
      type: "conversation",
      version: 2,
      agentId: "agent-1",
      conversationId: "conv-1",
      startedAt: new Date(0).toISOString(),
    }),
  ];
  for (let index = 0; index < eventCount; index += 1) {
    lines.push(
      JSON.stringify({
        type: "message",
        at: new Date(index * 1000).toISOString(),
        message: {
          role: index % 2 === 0 ? "user" : "assistant",
          content: index % 4 === 3 ? PROSE_PARAGRAPH.repeat(5) : `message ${String(index)}`,
        },
      }),
    );
  }
  return lines.join("\n");
}

const smallLog = logContent(50);
const largeLog = logContent(5_000);
const largeEvents = parseConversationLog(largeLog);

const results = [
  bench("parseConversationLog, 50 events", () => {
    parseConversationLog(smallLog);
  }),
  bench(
    "parseConversationLog, 5000 events",
    () => {
      parseConversationLog(largeLog);
    },
    { iterations: 40 },
  ),
  bench("reduceConversationLog, 5000 events", () => {
    reduceConversationLog(largeEvents);
  }),
];

report("conversation-log", results);
