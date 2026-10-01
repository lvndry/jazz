/**
 * Prepare equal benchmark workloads against an older production tree. Suite
 * implementations are copied from head when the suite exists on base. The text
 * and syntax primitives moved packages in PR724 without changing their bench
 * inputs, so only their import paths are remapped when the old paths exist.
 * Markdown parsing changed its contract and case names: base keeps its original
 * suite, and those differently named rows are deliberately not compared.
 * Presentation ownership also changed source APIs: its baseline keeps the
 * original reducer, hydration and layout suites rather than inserting runtime
 * compatibility code into production. Equal end-to-end renderer workloads
 * remain comparable through their existing fixture.
 * Run `bun scripts/prepare-benchmark-baseline.ts /path/to/base /path/to/head`.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [baseArgument, headArgument] = process.argv.slice(2);
if (baseArgument === undefined || headArgument === undefined)
  throw new Error("Expected base and head checkout directories");
const base = resolve(baseArgument);
const head = resolve(headArgument);
const moves = [
  ["../packages/cli/src/ui/text/syntax-spans", "../packages/cli/src/ui/fullscreen/syntax-spans"],
  [
    "../packages/cli/src/ui/text/terminal-cells",
    "../packages/cli/src/ui/fullscreen/terminal-cells",
  ],
] as const;

for (const name of readdirSync(join(head, "bench")).filter((file) => file.endsWith(".bench.ts"))) {
  const destination = join(base, "bench", name);
  if (!existsSync(destination)) continue;
  const hasSemanticDocument = existsSync(join(base, "packages/cli/src/ui/document.ts"));
  const hasLayoutIndex = existsSync(
    join(base, "packages/cli/src/ui/fullscreen/transcript-layout.ts"),
  );
  if (
    (!hasSemanticDocument &&
      [
        "activity-reducer.bench.ts",
        "markdown-split.bench.ts",
        "conversation-log.bench.ts",
      ].includes(name)) ||
    (!hasLayoutIndex && ["transcript-rows.bench.ts", "streaming-answer.bench.ts"].includes(name))
  ) {
    console.log(`${name}: keeping original baseline implementation for changed source API`);
    continue;
  }
  if (
    name === "markdown-prose.bench.ts" &&
    !existsSync(join(base, "packages/cli/src/ui/markdown/parse.ts"))
  ) {
    console.log(`${name}: keeping distinct legacy parser workload (not compared)`);
    continue;
  }
  let source = readFileSync(join(head, "bench", name), "utf8");
  for (const [current, previous] of moves) {
    const hasCurrent = existsSync(join(base, "bench", `${current}.ts`));
    const hasPrevious = existsSync(join(base, "bench", `${previous}.ts`));
    if (!hasCurrent && hasPrevious) source = source.replaceAll(current, previous);
  }
  writeFileSync(destination, source);
}
for (const name of ["harness.ts", "run.ts", "corpus.ts"]) {
  copyFileSync(join(head, "bench", name), join(base, "bench", name));
}
