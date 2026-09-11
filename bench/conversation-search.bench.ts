// The search overlay runs this on every keystroke while the query is open. It
// is the only per-keystroke path in the app that touches the disk: each call
// lists every agent's conversation directory, stats and reads up to
// MAX_SESSIONS_SCANNED logs (capped per file), parses each one's JSONL, and
// then scans every message for the needle by code point.
//
// `collectHits` is private, so the suite drives the public `search` against a
// throwaway history directory — which is the honest unit anyway, since the
// keystroke pays the scan and the read too, not just the match.
//
// `search` keeps each log's prepared (parsed, normalized) form, keyed by
// mtime and size, because between keystrokes only the query changes. That
// makes two different cadences worth measuring, and the suite keeps them
// apart: the first keystroke against logs nobody has scanned yet, and every
// keystroke after it. The cold rows alternate between two corpora — each
// query touches more logs than the cache holds, so alternating evicts the
// other corpus and guarantees a genuine cold scan every iteration.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { conversationLogContent } from "./corpus";
import { benchAsync, report } from "./harness";
import { conversationLogPath } from "../packages/adapters/src/history/conversation-log";
import { search } from "../packages/adapters/src/history/conversation-search";

const AGENTS = Number(process.env["BENCH_SEARCH_AGENTS"] ?? 5);
const CONVERSATIONS_PER_AGENT = Number(process.env["BENCH_SEARCH_CONVERSATIONS"] ?? 12);
const EVENTS_PER_CONVERSATION = Number(process.env["BENCH_SEARCH_EVENTS"] ?? 400);

// Synthetic history directories, so the numbers never depend on whatever the
// person running the bench happens to have in ~/.jazz.
function buildHistoryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "jazz-bench-search-"));
  for (let agent = 0; agent < AGENTS; agent += 1) {
    for (let conversation = 0; conversation < CONVERSATIONS_PER_AGENT; conversation += 1) {
      const agentId = `agent-${String(agent)}`;
      const conversationId = `conv-${String(agent)}-${String(conversation)}`;
      const filePath = conversationLogPath(agentId, conversationId, directory);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(
        filePath,
        conversationLogContent(EVENTS_PER_CONVERSATION, { agentId, conversationId }),
      );
    }
  }
  return directory;
}

const historyDirectory = buildHistoryDirectory();
// A second, identical corpus at different paths, to force cold scans.
const otherHistoryDirectory = buildHistoryDirectory();
const corpora = [historyDirectory, otherHistoryDirectory] as const;

// The fixtures are a few MB; do not leave them behind in the temp directory.
process.on("exit", () => {
  for (const directory of corpora) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Pinned so the relative "when" labels are stable across runs.
const NOW = Date.UTC(2026, 0, 1);
const options = { scope: "all" as const, dir: historyDirectory, now: NOW };

const results = [
  // The first keystroke on a corpus nobody has scanned: read, parse and
  // normalize every candidate, then match.
  await benchAsync(
    "search, no matches, cold logs (first keystroke)",
    async (iteration) => {
      await search("zzzznotpresent", {
        ...options,
        dir: corpora[iteration % 2] ?? historyDirectory,
      });
    },
    { iterations: 20, warmupIterations: 2 },
  ),
  // Typing one query, keystroke by keystroke: the prefixes a real search
  // actually issues. Only the first pays for preparing the logs.
  await benchAsync(
    "search, growing query (7 keystrokes)",
    async (iteration) => {
      const query = "transcr".slice(0, (iteration % 7) + 1);
      await search(query, options);
    },
    { iterations: 40, warmupIterations: 4 },
  ),
  // A common word: the budget fills early and the scan stops at the limit.
  await benchAsync(
    "search, hit-saturated query",
    async () => {
      await search("message", options);
    },
    { iterations: 40, warmupIterations: 4 },
  ),
  // The expensive shape: every line of every log is scanned to the end because
  // nothing matches — but the logs are already prepared.
  await benchAsync(
    "search, no matches, warm logs (full scan)",
    async () => {
      await search("zzzznotpresent", options);
    },
    { iterations: 40, warmupIterations: 4 },
  ),
  await benchAsync(
    "search, limit 10",
    async () => {
      await search("markdown", { ...options, limit: 10 });
    },
    { iterations: 40, warmupIterations: 4 },
  ),
  // Cheap by construction: an empty query short-circuits before any I/O, and
  // the overlay issues one every time the query is cleared.
  await benchAsync("search, empty query (short-circuit)", async () => {
    await search("   ", options);
  }),
];

report("conversation-search", results);
