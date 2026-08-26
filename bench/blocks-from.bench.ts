// The other half of the per-frame transcript path: bridge.tsx rebuilds the
// full Block[] from scrollback entries on every streaming delta, then restores
// identity so the transcriptRows memo can hit.
import { outputEntries } from "./corpus";
import { bench, report } from "./harness";
import { blocksFrom, shareUnchangedBlocks } from "../packages/cli/src/ui/fullscreen/bridge";

const ENTRIES = Number(process.env["BENCH_ENTRIES"] ?? 600);
const entries = outputEntries(ENTRIES);
const previousBlocks = blocksFrom(entries, "", []);

const results = [
  bench(`blocksFrom rebuild (${String(ENTRIES)} entries)`, () => {
    blocksFrom(entries, "streaming tail of the current reply ", []);
  }),
  bench(`shareUnchangedBlocks (${String(ENTRIES)} entries)`, () => {
    shareUnchangedBlocks(previousBlocks, blocksFrom(entries, "", []));
  }),
];

report("blocks-from", results);
