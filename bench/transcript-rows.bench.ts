// The fullscreen transcript's per-frame path (#394/#395): cold wrap of a whole
// conversation, the warm streaming tail that should hit the wrap cache, and
// the fingerprint tax paid even when nothing changed.
import { settledBlocks, PROSE_PARAGRAPH } from "./corpus";
import { bench, report } from "./harness";
import { transcriptRows } from "../packages/cli/src/ui/fullscreen/Transcript";
import type { Block } from "../packages/cli/src/ui/fullscreen/types";
import { setThemeVariant } from "../packages/cli/src/ui/theme";

const VIEWPORT = { width: 120, height: 40 };
const TURNS = Number(process.env["BENCH_TURNS"] ?? 200);
const settled = settledBlocks(TURNS);

const streamingTails: Block[][] = [];
let streamed = "";
for (let frame = 0; frame < 50; frame += 1) {
  streamed += "token ";
  streamingTails.push([
    ...settled,
    {
      id: "stream",
      seq: settled.length,
      kind: "agent",
      markdown: streamed + PROSE_PARAGRAPH,
      streaming: true,
    },
  ]);
}

const results = [
  // Theme toggling busts the wrap-cache epoch, so every iteration re-wraps the
  // full conversation — the pre-#395 cost of one streamed frame.
  bench(
    `cold full wrap (${String(TURNS * 3)} blocks)`,
    (iteration) => {
      setThemeVariant(iteration % 2 === 0 ? "dark" : "light");
      transcriptRows(settled, VIEWPORT);
    },
    { iterations: 60, warmupIterations: 4 },
  ),
  bench(`warm streaming tail (${String(TURNS * 3)} settled)`, (iteration) => {
    setThemeVariant("dark");
    transcriptRows(streamingTails[iteration % streamingTails.length] ?? settled, VIEWPORT);
  }),
  // Fresh array of the same block objects: the whole-transcript memo misses,
  // so this measures the per-frame fingerprint walk that survives the cache.
  bench(`fingerprint tax, unchanged blocks (${String(TURNS * 3)})`, () => {
    setThemeVariant("dark");
    transcriptRows([...settled], VIEWPORT);
  }),
];

report("transcript-rows", results);
