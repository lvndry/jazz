// Character-by-character fence highlighting — per frame for any transcript
// with a visible code block or diff receipt.
import { codeFenceLines, unifiedDiffLines } from "./corpus";
import { bench, report } from "./harness";
import { highlightFenceLines } from "../src/cli/ui/fullscreen/syntax-spans";

const shortFence = codeFenceLines(20);
const longFence = codeFenceLines(300);
const diff = unifiedDiffLines(120);

const results = [
  bench("highlightFenceLines ts 20 lines", () => {
    highlightFenceLines("ts", shortFence);
  }),
  bench("highlightFenceLines ts 300 lines", () => {
    highlightFenceLines("ts", longFence);
  }),
  bench("highlightFenceLines diff 120 lines", () => {
    highlightFenceLines("diff", diff);
  }),
];

report("syntax-spans", results);
