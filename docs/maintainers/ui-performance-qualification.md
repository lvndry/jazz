---
description: "Requalify the focused failing UI workloads in alternating fresh-process base/head pairs and feed the results to the performance gates."
---

# UI performance qualification

`bench/qualify-ui.ts` requalifies the exact failing Ink workloads from the
[2026-10-01 UI ownership qualification](../../bench/reports/ui-ownership-2026-10-01/qualification.md)
without relaxing any budget or discarding any observation. It exists because
the full matched pipeline run and the focused alternating reproduction both
fail Ink latency gates, and the focused failures still need tracked phase
reproduction before a production fix.

## What it measures

- `pipeline` mode mounts each checkout's own Ink fixture
  (`bench/ui-pipeline-fixture.ts` + `packages/cli/src/ui/store.ts`) and
  measures the two failing shapes — unicode and unbroken 1k chars over 20
  seeded turns at 120x40 — with the production renderer scheduling of that
  checkout. Each delta case reports the first painted delta (one frame) and
  all 32 steady frames separately. No frame is discarded as warmup, and each
  row's summary statistics (total, mean, p50, p95) are derived from the
  published durations, so a row can never disagree with its own observations.
- `memory` mode runs each checkout's untouched
  `bench/conversation-memory.bench.ts` worker with `ink 30
short-paragraphs`. The unchanged legacy conversation-memory worker keeps
  its GC, lifetime, source-retention and teardown costs inside the measured
  child wall time. The legacy checkout keeps its own fixture, so no
  production compatibility shim is inserted into the comparison.

Both modes run three alternating fresh-process base/head pairs, base first
in each pair. Every reported number is the median of the three fresh
processes; the report preserves every original observation.

## Reproduce

Prepare a matched benchmark baseline for the base checkout with
`scripts/prepare-benchmark-baseline.ts`, which copies the head's benchmark
suites and shared bench helpers into the base revision so both sides measure
the same workloads (keeping the base's original implementation where its
source APIs changed). Install the locked dependencies in each checkout, then
run the tool from the head checkout:

```sh
bun scripts/prepare-benchmark-baseline.ts /path/to/base-checkout /path/to/head-checkout
bun install --frozen-lockfile
(cd /path/to/base-checkout && bun install --frozen-lockfile)
bun bench/qualify-ui.ts pipeline --base /path/to/base-checkout --head /path/to/head-checkout --output /tmp/focused-pipeline
bun bench/qualify-ui.ts memory --base /path/to/base-checkout --head /path/to/head-checkout --output /tmp/focused-memory
```

The tool writes one report per side, `/tmp/focused-pipeline.base.json` and
`/tmp/focused-pipeline.head.json` (same for memory), and prints a per-pair
summary line. Both sides are validated before either report is written, so a
mismatch discovered on one side never publishes a partial report for the
other. Each report carries `version`, `samples`, `mode`, `side`, the
`runtime` identity (`platform`, `arch`, `bun`) and the per-side `results`
rows that feed the existing relative gates:

```sh
bun scripts/performance-check.ts /tmp/focused-pipeline.base.json /tmp/focused-pipeline.head.json
bun scripts/performance-check.ts /tmp/focused-memory.base.json /tmp/focused-memory.head.json
```

`base` and `head` must be different directories containing the mode's
fixture files. The tool rejects missing or unknown arguments, non-directory
checkouts, missing fixture files, malformed or partial worker JSON, pipeline
rows with a wrong name or iteration count, summary statistics that
contradict the row's own published durations, rows whose metrics do not
measure the pinned 1k-char, 20-turn workload, mismatched metric key sets
across the three samples, and nonzero worker exit statuses before writing
any report. Child processes run through argument arrays (no shell
interpolation) inside a fresh temporary `JAZZ_HOME` passed as that variable,
with a pinned styled offline environment (`FORCE_COLOR=3`, `NO_COLOR=''`,
`JAZZ_OFFLINE=1`, `JAZZ_DISABLE_KEYRING=1`, `JAZZ_UI_GLYPHS=unicode`) that is
released on success and failure.

## Partial-workload limits

The tool measures only the four focused pipeline rows (unicode and unbroken,
first and steady) and the single focused memory row. It is a focused
reproduction, not the full suite: it does not cover the 10k/50k pipeline
cases, prose shapes, OpenTUI, buffer/pacing/resize rows, or the full
conversation-memory matrix. Absolute budgets for those remain enforced by
`bun scripts/performance-check.ts --absolute` over a complete
`bench/run.ts` report. The focused reports therefore establish relative
behavior of the failing workloads only; they do not establish that CI passes
or that the original user freeze persists.

## Original failing qualification evidence

The 2026-10-01 run (macOS ARM64, Bun 1.4.2, offline synthetic fixtures,
styled output) is preserved at
`bench/results/ui-ownership-2026-10-01/` (the write-up is tracked at
`bench/reports/ui-ownership-2026-10-01/qualification.md;` the raw per-run
JSONs stay local),
which records the corrected pipeline comparison (fail, 3 metric gates), the
earlier memory lifetime comparison (fail, Ink30 p50/p95) and the focused
Ink30 lifetime comparison (pass), with links to every archived base/head
report.

## Tests and checks

The tool's pure surface — CLI parsing, malformed or partial worker payloads,
incoherent summary statistics, misnamed or miscounted pipeline rows, and
unequal, duplicated or missing result samples — is covered by
`bench/qualify-ui.test.ts`, which needs no checkout directory and spawns no
worker process. The real parent CLI and worker dispatch are covered by
`bench/qualify-ui.integration.test.ts`, which runs the actual runner against
synthetic checkouts for three alternating pairs and asserts the complete
four-row protocol, forced styled environment, isolated temporary `JAZZ_HOME`
values, cleanup and failure behavior:

```sh
bun test bench/qualify-ui.test.ts bench/qualify-ui.integration.test.ts
```

The owned benchmark files lint under the shared `bench/**` configuration:

```sh
bun eslint bench/qualify-ui.ts bench/qualify-ui.test.ts --no-error-on-unmatched-pattern
```

This guide's format is checked by the repo markdownlint configuration:

```sh
bunx markdownlint-cli2 docs/maintainers/ui-performance-qualification.md
```
