# Benchmarks

Benchmarks for Jazz's CPU, terminal, memory, disk and startup paths. Suites run
separately from `bun test`; the Performance budgets workflow builds the actual
release binary and compares base and head on the same runner.

```bash
bun run bench                 # all suites
bun run bench transcript      # filename filter
BENCH_ITERATIONS=500 bun run bench markdown
bun run bench --samples 3 --output head-report.json
bun scripts/performance-check.ts base-report.json head-report.json
bun scripts/performance-check.ts --absolute head-report.json
bun scripts/performance-check.ts --binary /path/to/base-jazz /path/to/head-jazz
```

Each suite prints a human table plus one JSON line per row for tooling. To
compare against a baseline, run the same suite in a worktree checked out at the
commit under test:

```bash
git worktree add /tmp/jazz-baseline <ref>
cd /tmp/jazz-baseline && bun install --frozen-lockfile && bun run bench transcript
```

## Suites

| suite                    | measures                                                                                         | cadence in the app          |
| ------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------- |
| transcript-rows          | `transcriptRows` cold wrap, warm streaming tail, fingerprint walk                                | per frame                   |
| streaming-answer         | one streaming answer per reveal frame at 1k/10k/50k, prose and one fence                         | per reveal frame (30fps)    |
| blocks-from              | `blocksFrom` rebuild + `shareUnchangedBlocks` identity pass                                      | per frame                   |
| markdown-prose           | `parseProse` / `inlineSegments` lexing                                                           | per dirty block per frame   |
| terminal-cells           | grapheme width measurement across script classes                                                 | innermost wrap leaf         |
| syntax-spans             | code fence and diff highlighting                                                                 | per visible fence per frame |
| markdown-split           | one-shot vs `StreamSplitScanner`, by tail shape + reducer fold                                   | per stream delta            |
| store-writes             | `UIStore.appendStream` / batched `printOutput`                                                   | per delta / per message     |
| stream-processor         | `StreamProcessor.process` over a synthetic provider stream                                       | per stream delta            |
| reasoning-parser         | `TagPairParser.feed`, passthrough vs `<think>` vs split tags                                     | per stream delta            |
| token-counter            | `TokenCounter.countText`/`countMessage`, BPE vs ratio branches                                   | per message                 |
| context-window           | `ContextWindowManager.calculateTotalTokens`, BPE vs ratio                                        | per turn on long chats      |
| tool-result-clearing     | `clearToolResults` walk, BPE vs ratio                                                            | per turn on long chats      |
| agent-prompt             | `buildSystemPrompt` cold vs cached + work-state preamble                                         | per turn / on resume        |
| summarizer-chunking      | `chunkForSummarizer` by history length and budget                                                | per compaction              |
| conversation-log         | parse + reduce + `outputEntriesFromHistory`                                                      | session resume              |
| conversation-search      | `search` over a synthetic history directory                                                      | per keystroke while open    |
| tool-formatter           | `formatToolResult` at 1KB / 100KB / 1MB                                                          | per tool call               |
| capped-output            | `appendCapped` fold, `decodeCapped`, `tailForModel`                                              | per stdout chunk            |
| diff                     | `generateDiff` by file size and edit distance                                                    | per write / edit call       |
| activity-reducer         | `reduceEvent` fold over a recorded run                                                           | per stream event            |
| mcp-schema               | `convertMCPSchemaToZod` per tool and per 40-tool server                                          | per MCP connection          |
| ui-pipeline              | store delta to terminal paint in Ink/OpenTUI, pacing and resize                                  | per frame                   |
| conversation-memory      | isolated renderer children, retained heap, post-clear heap, RSS and sampled transient cells      | long conversations          |
| filesystem-config-models | real 100/1k/10k capped approval scans; configuration read/validate; model catalog decode/resolve | approval / startup          |
| startup                  | source and compiled --version; fresh/warm compiled PTY home to accepted draft                    | per invocation              |

## Conventions

- Deterministic corpora only (`corpus.ts`) — no randomness, so runs on the same
  commit are comparable.
- One process per suite (`run.ts`) so module-level caches (wrap cache, glyph
  tables) never leak between suites.
- `harness.ts` pins `JAZZ_UI_GLYPHS=unicode`; benches that exercise chalk force
  `chalk.level = 3`. Both match a real terminal rather than a piped CI shell.
- Benches that depend on a module-level cache must control it explicitly (see
  the theme-variant toggle in `transcript-rows.bench.ts`, and the cold/warm
  pair in `agent-prompt.bench.ts`).
- `bench` for sync paths, `benchAsync` for paths only reachable through a
  promise. Both report identically.
- Suites that touch the filesystem build their own fixtures under a
  `mkdtemp` directory and point `JAZZ_HOME` (or an explicit `dir` option) at
  it, so no number depends on the state of the user's `~/.jazz` — and no
  bench reads their real history.
- No provider calls. Where a suite covers streaming (`stream-processor`), the
  provider is replaced by a pre-resolved async iterable, so no network
  latency lands in the numbers.
- Where a cache sits on the path, the suite keeps a cold row and a warm row
  rather than only one of them (`token-counter`, `conversation-search`,
  `diff`). A fixture that repeats one input silently turns into a
  cache-hit benchmark and stops defending the work underneath it.

## Budgets and reproducibility

`run.ts --output` writes versioned reports with OS, architecture and Bun version.
`--samples 3` uses three fresh processes per suite and retains the median of each
reported measurement, reducing single-process outliers. Timing percentiles remain
percentiles within a process; a report does not pool differently warmed processes.
Numeric `metrics` carry suite-specific observations such as retained bytes.
Context accounting and summarizer preparation use 100 measured iterations
after 20 warmups: p95 over only ten samples was just the maximum sample and
proved unstable in paired runs. Fixture sizes and gate thresholds stay fixed.
Cold request hashing and store writes use 200 measured iterations after 40
warmups. These allocation-heavy cases include garbage collection costs; longer
samples give p95 more tail observations than a 40-iteration run without changing
the workload or excluding slow samples.

[budgets.json](./budgets.json) is the policy reviewed alongside code. Current
latency gates require a regression larger than both 30% and 0.5ms in either p50
or p95. These conservative allowances are initial noise guards, not a claim of
statistical significance. Tighten them using repeated runner history. Absolute
ceilings cover new suites before a corresponding baseline exists: filesystem,
configuration and fixture model discovery must finish within one second at p95.
Long-conversation children have a 1GiB RSS ceiling and must release history to
within 64MiB of their warmed heap after clearing the transcript.
Ordinary UI pipeline p95 must stay below 250ms, including intentional pacing
delays and resize debounce. The two explicit open-fence buffer cases have
separate 2500ms ceilings because production intentionally waits up to 2000ms
for an unfinished fence. Only their exact case names are excluded from the
250ms rule; renamed or additional cases remain subject to it. This is an initial catastrophic-regression safeguard,
not a 60fps frame budget. Set tighter frame-specific budgets after stable CI
measurements establish the actual tail latency. Retained deltas
may be negative after GC; reports preserve those improvements.

The complete release binary includes the embedded native libraries. Its raw and
release-equivalent gzip level-9 sizes each may grow by at most 5% or 1MiB, whichever permits more growth;
200MiB is an additional emergency ceiling for the Linux x64 CI artifact.
These limits include Bun itself; review the ceilings and runner history when
upgrading Bun rather than silently accepting an oversized release. The compiled runtime is intentionally
included: a JavaScript bundle alone would miss the artifact users download.

CI pins `JAZZ_OFFLINE=1`, `NO_COLOR=''` and `FORCE_COLOR=3` on both revisions to measure the
styled production theme consistently. An inherited `NO_COLOR=1` would change
span allocations and make a memory comparison misleading. CI uses the `smoke` profile: 100 prose turns plus 30 stress turns with short
paragraphs. The full local profile exercises 100 and 500 prose turns plus
100 stress turns; `BENCH_MEMORY_TURNS=1000,5000` enables extended runs.
The current fixture writes ANSI through the native renderer. Native 500-turn
runs on this machine reached about 1.80GB peak RSS in
OpenTUI and 1.11GB in Ink. Clearing the transcript released retained heap,
while RSS remained a high-water measurement; those longer runs exceed the
1GiB smoke ceiling and expose a resource-scaling concern. CI checks out both revisions, installs their locked dependencies and builds both
release artifacts serially. Shared suites use the pull request's fixture and
harness code on both revisions. `prepare-benchmark-baseline.ts` remaps only
the extracted syntax/terminal primitives to their equivalent old module paths.
The former markdown parser has a different contract and different case names;
it runs on base but its rows do not participate in this PR's parser comparison.
The new parser instead has explicit p95 ceilings: 10ms for the 50KB reply
and 1ms for the smaller prose and inline cases. A color/offline-pinned local
macOS ARM64 run measured roughly 1.7ms p95 for 50KB and 0.01–0.05ms for
the smaller cases; these ceilings are initial workload safeguards, not
a statistically calibrated cross-platform baseline. New suites run on head and use absolute budgets. Startup compares source and compiled `--version` on both revisions;
`BENCH_STARTUP_BASELINE=1` skips base interactive readiness because the previous
home menu did not accept typed drafts. Head startup must reach readiness within
two seconds, and compiled `--version` within 100ms.
Only matching suite/name rows participate in the relative comparison. Reports
with different OS, architecture or Bun version are rejected. Results remain CI
artifacts for 14 days; the workflow does not post comments or update baselines.

CPU scaling, runner contention and filesystem caches still affect measurements.
A local repeat of six suites using matched inputs and three processes passed
all comparison gates; reversing the order removed or reversed apparent tail
regressions in unchanged hashing/compaction code. That host also had an unrelated
long-running test consuming one CPU core, so these are reproducibility checks,
not measurements from an idle host.
The disk suites measure a real scan after fixture creation, with warm OS caches;
they are not physical-disk cold-read benchmarks. Model discovery uses a synthetic disk metadata catalog and in-memory
HTTP Responses, exercising production JSON decode, extraction and metadata
resolution without measuring provider/network availability. Configuration
validation excludes OS keyring and full service construction.

## Remaining boundaries

- `stream-processor` isolates provider decoding. `ui-pipeline` measures store,
  React commit, render and terminal capture with real pacing/resize. Provider
  network latency and remote terminal transport remain outside those fixtures.
- Summarizer parse/apply helpers beyond `chunkForSummarizer`; the LLM call
  itself stays out of scope.
- Per-keystroke composer editing (`composer-edit`, `keymap`, `text-utils`)
  was measured and left out: each call is O(1) on a short buffer, so there is
  no signal to defend.
- The `grep`/`find` tools shell out to ripgrep, so their cost is process
  spawn (already covered by `startup`) plus I/O, not CPU worth pinning here.
