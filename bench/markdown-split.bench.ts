// Split-point finding runs on EVERY stream delta, over the whole accumulated
// tail. Two entry points share one implementation:
//
// - `findLastSafeSplitPoint` is one-shot: it rescans the whole tail per call,
//   so growing a block through it costs O(tail²) before the block promotes.
// - `createStreamSplitScanner` is stateful: it commits each line of the tail
//   exactly once across a run of appends. This is the path the streaming
//   buffer takes.
//
// The per-call rows show cost by tail shape. The paired growth rows isolate
// where the scanner actually earns its keep, which is narrower than "it is
// linear and the other one is not":
//
// - When the tail promotes (ordinary prose), the caller drops the promoted
//   prefix and the pending tail stays short, so both entry points are linear
//   in reply length and the scanner wins a constant factor.
// - When the tail CANNOT promote — an unclosed fence — nothing is ever
//   dropped, the pending buffer grows to `MAX_PENDING_TAIL`, and the one-shot
//   path rescans all of it per delta. That is the quadratic the scanner
//   exists to remove, and it is the pair that shows it.
//
// The `reduceScrollback` fold then measures the same work end-to-end, through
// the reducer that owns the rebasing in the app.
import { markdownReply, streamDeltas } from "./corpus";
import { bench, report } from "./harness";
import {
  createStreamSplitScanner,
  findLastSafeSplitPoint,
  MAX_PENDING_TAIL,
} from "../packages/cli/src/presentation/markdown-split";
import {
  initialScrollbackState,
  reduceScrollback,
} from "../packages/cli/src/ui/adapters/terminal-output-adapter";

/** Provider deltas are small; this is roughly one token's worth of chars. */
const DELTA_CHARS = 40;

const proseTail = markdownReply(8_000);
const openFenceTail = "```ts\n" + "const line = compute();\n".repeat(300);
const openListTail = "- item that keeps going\n".repeat(300);
const tableTail = "| cell | cell | cell |\n".repeat(300);
const deltas = streamDeltas(3_000);

/**
 * Stream `full` through a pending buffer the way the reducer does: append a
 * delta, ask for a split, and when there is one, promote that prefix out of
 * the buffer (the scanner's contract requires a `reset` after such a rebase).
 *
 * Both entry points are driven through the identical loop and promote at the
 * identical offsets, so the only difference measured is the split cost.
 */
function streamWithRebase(full: string, useScanner: boolean): void {
  const scanner = createStreamSplitScanner();
  let pending = "";
  for (let offset = 0; offset < full.length; offset += DELTA_CHARS) {
    pending += full.slice(offset, offset + DELTA_CHARS);
    const split = useScanner ? scanner.evaluate(pending) : findLastSafeSplitPoint(pending);
    if (split > 0) {
      pending = pending.slice(split);
      if (useScanner) scanner.reset();
    }
  }
}

/**
 * Every prefix of a tail that never promotes, in `DELTA_CHARS` steps — the
 * exact sequence of pending-buffer values an unclosed fence passes through.
 *
 * Built once, outside the timed region: slicing a growing tail is itself
 * quadratic, and leaving it inside would charge both entry points the same
 * large constant and hide the difference between them.
 */
function growthPrefixes(tail: string): string[] {
  const prefixes: string[] = [];
  for (let length = DELTA_CHARS; length < tail.length + DELTA_CHARS; length += DELTA_CHARS) {
    prefixes.push(tail.slice(0, Math.min(tail.length, length)));
  }
  return prefixes;
}

function growTail(prefixes: readonly string[], split: (text: string) => number): void {
  for (const prefix of prefixes) {
    split(prefix);
  }
}

// A 32KB reply: four times the pending cap, so promotion happens repeatedly.
const streamedReply = markdownReply(32_000);
// Pinned at the hard cap: the largest tail either entry point ever sees, and
// the size at which the one-shot path is at its worst.
const cappedFence = growthPrefixes(openFenceTail.slice(0, MAX_PENDING_TAIL));

const results = [
  bench("split point, 8KB prose tail", () => {
    findLastSafeSplitPoint(proseTail);
  }),
  bench("split point, 7KB open fence", () => {
    findLastSafeSplitPoint(openFenceTail);
  }),
  bench("split point, 7KB open list", () => {
    findLastSafeSplitPoint(openListTail);
  }),
  bench("split point, 7KB table", () => {
    findLastSafeSplitPoint(tableTail);
  }),
  // The ordinary path: a 32KB reply streamed with rebasing. Both entry points
  // are linear here, because promotion keeps the pending tail short.
  bench(
    "stream 32KB reply with rebase, one-shot per delta",
    () => {
      streamWithRebase(streamedReply, false);
    },
    { iterations: 20, warmupIterations: 2 },
  ),
  bench(
    "stream 32KB reply with rebase, StreamSplitScanner",
    () => {
      streamWithRebase(streamedReply, true);
    },
    { iterations: 20, warmupIterations: 2 },
  ),
  // The pair the scanner exists for: an unclosed fence never promotes, so the
  // pending tail grows to the cap and the one-shot path rescans all of it on
  // every delta.
  bench(
    "grow 8KB open fence (never promotes), one-shot per delta",
    () => {
      growTail(cappedFence, findLastSafeSplitPoint);
    },
    { iterations: 20, warmupIterations: 2 },
  ),
  bench(
    "grow 8KB open fence (never promotes), StreamSplitScanner",
    () => {
      const scanner = createStreamSplitScanner();
      growTail(cappedFence, (text) => scanner.evaluate(text));
    },
    { iterations: 20, warmupIterations: 2 },
  ),
  bench(
    "reduceScrollback fold, 3k deltas",
    () => {
      let state = initialScrollbackState();
      let deltaIndex = 0;
      for (const delta of deltas) {
        deltaIndex += 1;
        state = reduceScrollback(state, {
          type: "appendStream",
          kind: "response",
          delta,
          nextId: `pending-${String(deltaIndex)}`,
          finalizeId: `finalized-${String(deltaIndex)}`,
        });
      }
    },
    { iterations: 20, warmupIterations: 2 },
  ),
];

report("markdown-split", results);
