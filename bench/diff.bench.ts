// Every `write_file` and `edit_file` renders a colored patch before the user
// approves it, so this runs once per file-mutating tool call, on the whole
// file. `createPatch` from the `diff` package is a Myers diff — O(N·D) in
// file length and edit distance — which makes it the one per-tool-call path
// with real algorithmic cost rather than string formatting.
//
// Rows vary both terms: file size at a fixed single-line edit, then edit
// distance at a fixed file size.
//
// `generateDiff` keeps the last patch it computed, because one mutation
// renders the same patch two or three times. So the per-call rows alternate
// between two variants of the new content: consecutive calls then always
// differ, every row measures a real Myers diff, and the cache cannot flatter
// them. The two "three renders" rows at the bottom are the opposite case —
// identical inputs, the sequence a tool actually runs.
import chalk from "chalk";
import { bench, report } from "./harness";
import { generateDiff, generateDiffWithMetadata } from "../packages/core/src/utils/diff";

chalk.level = 3;

function sourceFile(lineCount: number): string {
  const lines: string[] = [];
  for (let index = 0; index < lineCount; index += 1) {
    lines.push(
      `  const value${String(index)} = compute(${String(index)}); // note ${String(index)}`,
    );
  }
  return lines.join("\n");
}

/** Rewrite every `stride`-th line: `stride: 1` is a whole-file rewrite. */
function withEdits(original: string, stride: number, marker = "edited"): string {
  return original
    .split("\n")
    .map((line, index) => (index % stride === 0 ? `${line} // ${marker}` : line))
    .join("\n");
}

/**
 * Two equivalent edits of the same file, to alternate between. Both do the
 * same amount of diffing; they differ only in the text of the edit, which is
 * enough to keep consecutive calls off the one-entry patch cache.
 */
function editVariants(original: string, stride: number): readonly [string, string] {
  return [withEdits(original, stride, "edited"), withEdits(original, stride, "revised")];
}

const small = sourceFile(120);
const medium = sourceFile(1_200);
const large = sourceFile(12_000);

const smallEdited = editVariants(small, 120);
const mediumEdited = editVariants(medium, 1_200);
const largeEdited = editVariants(large, 12_000);
const mediumScatteredPair = editVariants(medium, 10);
const mediumRewrittenPair = editVariants(medium, 1);

/** Pick this iteration's variant: alternating means every call is a real diff. */
function variant(pair: readonly [string, string], iteration: number): string {
  return pair[iteration % 2] ?? pair[0];
}

const results = [
  bench("generateDiff 120 lines, 1 edit", (iteration) => {
    generateDiff(small, variant(smallEdited, iteration), "src/module.ts");
  }),
  bench(
    "generateDiff 1.2k lines, 1 edit",
    (iteration) => {
      generateDiff(medium, variant(mediumEdited, iteration), "src/module.ts");
    },
    { iterations: 60 },
  ),
  bench(
    "generateDiff 12k lines, 1 edit",
    (iteration) => {
      generateDiff(large, variant(largeEdited, iteration), "src/module.ts");
    },
    { iterations: 20, warmupIterations: 2 },
  ),
  // Same file, more edit distance: the D term, which the line count alone
  // does not predict.
  bench(
    "generateDiff 1.2k lines, every 10th line edited",
    (iteration) => {
      generateDiff(medium, variant(mediumScatteredPair, iteration), "src/module.ts");
    },
    { iterations: 40 },
  ),
  // The cliff: no line survives, so the Myers matrix is at its widest. Two
  // orders of magnitude above the same file with one edited line, paid
  // synchronously before the approval prompt can render.
  bench(
    "generateDiff 1.2k lines, whole-file rewrite",
    (iteration) => {
      generateDiff(medium, variant(mediumRewrittenPair, iteration), "src/module.ts");
    },
    { iterations: 10, warmupIterations: 2 },
  ),
  // The default path caps the rendered patch at 20 lines; a scattered edit
  // hits that cap, so this is the truncation branch rather than a full render.
  bench(
    "generateDiffWithMetadata, truncated at maxLines",
    (iteration) => {
      generateDiffWithMetadata(medium, variant(mediumScatteredPair, iteration), "src/module.ts", {
        maxLines: 20,
      });
    },
    { iterations: 40 },
  ),
  // New-file writes skip the diff entirely — the cheap branch, pinned so a
  // regression that starts diffing against "" would show up here.
  bench("generateDiff new file (creation summary)", () => {
    generateDiff("", large, "src/module.ts");
  }),
  // What one `write_file` actually runs: a full patch for the approval
  // preview, a capped one for terminal output, then a full one for the Ctrl+O
  // expansion — all on identical content. Should cost about the same as the
  // single-call row above it, not three times as much.
  // A fresh target each iteration, so the first of the three renders is a real
  // diff exactly as it is in the app; only the second and third can be spared.
  // Should land near the single-call row for the same edit, not three times it.
  bench(
    "one mutation's three renders, 1.2k lines scattered edits",
    (iteration) => {
      const target = variant(mediumScatteredPair, iteration);
      generateDiffWithMetadata(medium, target, "src/module.ts", {
        maxLines: Number.POSITIVE_INFINITY,
      });
      generateDiffWithMetadata(medium, target, "src/module.ts");
      generateDiff(medium, target, "src/module.ts", {
        maxLines: Number.POSITIVE_INFINITY,
        fullPatch: true,
      });
    },
    { iterations: 40 },
  ),
  // The same sequence on the whole-file rewrite, where each render is ~190ms.
  bench(
    "one mutation's three renders, 1.2k lines rewritten",
    (iteration) => {
      const target = variant(mediumRewrittenPair, iteration);
      generateDiffWithMetadata(medium, target, "src/module.ts", {
        maxLines: Number.POSITIVE_INFINITY,
      });
      generateDiffWithMetadata(medium, target, "src/module.ts");
      generateDiff(medium, target, "src/module.ts", {
        maxLines: Number.POSITIVE_INFINITY,
        fullPatch: true,
      });
    },
    { iterations: 10, warmupIterations: 2 },
  ),
];

report("diff", results);
