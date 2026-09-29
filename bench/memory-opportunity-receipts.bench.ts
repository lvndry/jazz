/**
 * Measure request identity hashing for reused messages, one appended message,
 * and entirely new message objects. Run with `bun bench/memory-opportunity-receipts.bench.ts`.
 * The cold case includes object allocation, uncached SHA-256 work and cache
 * insertion. Its 200 measured iterations after 40 warmups retain GC costs while
 * giving p95 more tail observations than a short 40-iteration sample.
 */
import { bench, report } from "./harness";
import { requestContentHash } from "../packages/core/src/agent/memory-opportunity-receipts";
import type { ChatMessage } from "../packages/core/src/types/message";

const MESSAGE_COUNT = 500;
const MESSAGE_CHARS = 2_000;

const transcript: ChatMessage[] = Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
  role: index % 2 === 0 ? "user" : "assistant",
  content: `message ${index} `.padEnd(MESSAGE_CHARS, "x"),
}));

requestContentHash(transcript);

const results = [
  bench("requestContentHash, 500 × 2KB, unchanged transcript", () => {
    requestContentHash(transcript);
  }),
  bench("requestContentHash, 500 × 2KB, one new message", (iteration) => {
    requestContentHash([...transcript, { role: "user", content: `new turn ${iteration}` }]);
  }),
  bench(
    "requestContentHash, 500 × 2KB, cold",
    () => {
      requestContentHash(transcript.map((message) => ({ ...message })));
    },
    { iterations: 200, warmupIterations: 40 },
  ),
];

report("memory-opportunity-receipts", results);
