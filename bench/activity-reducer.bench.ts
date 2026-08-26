// The activity reducer runs on every StreamEvent — per delta during streaming.
// This folds a realistic recorded-run shape: thinking, tool round, streamed
// reply.
import { bench, report } from "./harness";
import { createAccumulator, reduceEvent } from "../packages/cli/src/presentation/activity-reducer";
import type { StreamEvent } from "../packages/core/src/types/streaming";

const stubInk = (node: unknown): string => `[ink:${typeof node}]`;

function recordedRun(chunkCount: number): StreamEvent[] {
  const events: StreamEvent[] = [{ type: "text_start" }];
  let accumulated = "";
  for (let index = 0; index < chunkCount; index += 1) {
    accumulated += `token${String(index)} `;
    events.push({
      type: "text_chunk",
      delta: `token${String(index)} `,
      accumulated,
      sequence: index,
    });
  }
  return events;
}

const run = recordedRun(1_000);

const results = [
  bench(
    "reduceEvent fold, 1k text chunks",
    () => {
      const accumulator = createAccumulator("bench-agent");
      for (const event of run) {
        reduceEvent(accumulator, event, stubInk);
      }
    },
    { iterations: 60 },
  ),
];

report("activity-reducer", results);
