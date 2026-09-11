// Spawned-process output capping. Every `execute_command`, `find` and custom
// tool run folds its stdout through `appendCapped` once per `data` event, then
// decodes once at the end — so the fold is per chunk and the decode is per
// tool call, at up to the 256KB cap.
//
// `appendCapped` rebuilds the chunk array per append (`[...current.chunks,
// chunk]`), so the fold is O(chunks²) in array copying. The two chunk sizes
// below hold total bytes roughly constant and vary only the chunk count,
// which is what that term keys off.
import { bench, report } from "./harness";
import {
  appendCapped,
  decodeCapped,
  decodeCappedText,
  tailForModel,
  DEFAULT_SPAWN_OUTPUT_CAP_BYTES,
  EMPTY_CAPPED_OUTPUT,
  type CappedOutput,
} from "../packages/core/src/agent/tools/capped-output";

const CAP = DEFAULT_SPAWN_OUTPUT_CAP_BYTES;

// A build log: the shape that actually arrives on stdout, ASCII so byte length
// and string length agree except where the CJK row below deliberately differs.
function logChunk(index: number, sizeBytes: number): Buffer {
  const line = `[${String(index).padStart(6, "0")}] compiled module ${String(index)} in 12ms\n`;
  return Buffer.from(
    line.repeat(Math.max(1, Math.ceil(sizeBytes / line.length))).slice(0, sizeBytes),
  );
}

function fold(chunkBytes: number, totalBytes: number): CappedOutput {
  const chunk = logChunk(1, chunkBytes);
  let output = EMPTY_CAPPED_OUTPUT;
  for (let written = 0; written < totalBytes; written += chunkBytes) {
    output = appendCapped(output, chunk, CAP);
  }
  return output;
}

// Multi-byte, to exercise the byte-vs-code-unit accounting the cap exists for.
const cjkChunk = Buffer.from("編譯模組完成，耗時十二毫秒。\n".repeat(8));

const under = fold(4_096, 200_000);
const over = fold(4_096, 2_000_000);
const overText = decodeCapped(over);

const results = [
  bench(
    "appendCapped fold, 200KB in 4KB chunks (49 appends)",
    () => {
      fold(4_096, 200_000);
    },
    { iterations: 60 },
  ),
  bench(
    "appendCapped fold, 200KB in 512B chunks (391 appends)",
    () => {
      fold(512, 200_000);
    },
    { iterations: 60 },
  ),
  // Past the cap every further append short-circuits, so this measures the
  // flood path: a command that keeps printing after it has been cut off.
  bench(
    "appendCapped fold, 2MB flood into 256KB cap",
    () => {
      fold(4_096, 2_000_000);
    },
    { iterations: 20, warmupIterations: 2 },
  ),
  bench("appendCapped 200 multi-byte chunks", () => {
    let output = EMPTY_CAPPED_OUTPUT;
    for (let index = 0; index < 200; index += 1) {
      output = appendCapped(output, cjkChunk, CAP);
    }
  }),
  bench(
    "decodeCapped 200KB",
    () => {
      decodeCapped(under);
    },
    { iterations: 60 },
  ),
  // The parser-facing decode: drops the cap-severed last line so a half line
  // never reaches a caller that will split on newlines.
  bench(
    "decodeCappedText 256KB truncated, dropIncompleteLastLine",
    () => {
      decodeCappedText(over, { trim: "end", dropIncompleteLastLine: true });
    },
    { iterations: 60 },
  ),
  bench("tailForModel 256KB -> 2000 chars", () => {
    tailForModel(overText);
  }),
];

report("capped-output", results);
