// Session resume (--continue) parses and reduces the whole JSONL log, then
// replays the surviving messages into the scrollback store, all before the
// first prompt renders — this is the startup tax of a long-lived session.
import { conversationLogContent } from "./corpus";
import { bench, report } from "./harness";
import {
  parseConversationLog,
  reduceConversationLog,
} from "../packages/adapters/src/history/conversation-log";
import { outputEntriesFromHistory } from "../packages/cli/src/ui/hydrate-transcript";

const smallLog = conversationLogContent(50);
const largeLog = conversationLogContent(5_000);
const largeEvents = parseConversationLog(largeLog);
const largeMessages = reduceConversationLog(largeEvents)?.messages ?? [];

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
  // The last leg of resume: reduced history becomes scrollback entries. The
  // store write itself is `store-writes`; this is the mapping in front of it.
  bench("outputEntriesFromHistory, 5000 messages", () => {
    outputEntriesFromHistory(largeMessages);
  }),
];

report("conversation-log", results);
