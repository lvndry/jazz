// Every model request with memory in scope identifies itself by hashing the
// transcript. That cost repeats per iteration and grows with the run, so it must
// stay proportional to what changed, not to the transcript's total size.
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
    { iterations: 40 },
  ),
];

report("memory-opportunity-receipts", results);
