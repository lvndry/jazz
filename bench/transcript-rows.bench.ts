// The fullscreen transcript's per-frame path (#394/#395): cold wrap of a whole
// conversation, the warm streaming tail that should hit the wrap cache, and
// the fingerprint tax paid even when nothing changed.
import { settledBlocks, PROSE_PARAGRAPH } from "./corpus";
import { bench, report } from "./harness";
import { createTranscriptLayout } from "../packages/cli/src/ui/fullscreen/transcript-layout";
import type { Block } from "../packages/cli/src/ui/fullscreen/types";
import { getGlyphs } from "../packages/cli/src/ui/glyphs";
import { setThemeVariant, getThemeRevision, THEME } from "../packages/cli/src/ui/theme";

const layout = createTranscriptLayout();
function frame(blocks: readonly Block[]): void {
  const index = layout.update(blocks, {
    width: VIEWPORT.width,
    glyphs: getGlyphs(),
    themeRevision: getThemeRevision(),
    colors: THEME,
  });
  index.window(Math.max(0, index.length - VIEWPORT.height), VIEWPORT.height);
}

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
      frame(settled);
    },
    { iterations: 60, warmupIterations: 4 },
  ),
];

setThemeVariant("dark");
frame(settled);
results.push(
  bench(`warm streaming tail (${String(TURNS * 3)} settled)`, (iteration) => {
    frame(streamingTails[iteration % streamingTails.length] ?? settled);
  }),
  // Fresh array of the same block objects: the whole-transcript memo misses,
  // so this measures the per-frame fingerprint walk that survives the cache.
  bench(`fingerprint tax, unchanged blocks (${String(TURNS * 3)})`, () => {
    frame([...settled]);
  }),
);

report("transcript-rows", results);
