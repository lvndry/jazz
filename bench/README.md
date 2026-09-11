# Benchmarks

CPU benchmarks for jazz's hot paths, so perf claims ship with numbers. Nothing
here runs in the build or in `bun test`.

```bash
bun run bench                 # all suites
bun run bench transcript      # filename filter
BENCH_ITERATIONS=500 bun run bench markdown
```

Each suite prints a human table plus one JSON line per row for tooling. To
compare against a baseline, run the same suite in a worktree checked out at the
commit under test:

```bash
git worktree add /tmp/jazz-baseline <ref>
cd /tmp/jazz-baseline && bun install --frozen-lockfile && bun run bench transcript
```

## Suites

| suite                | measures                                                          | cadence in the app          |
| -------------------- | ----------------------------------------------------------------- | --------------------------- |
| transcript-rows      | `transcriptRows` cold wrap, warm streaming tail, fingerprint walk | per frame                   |
| blocks-from          | `blocksFrom` rebuild + `shareUnchangedBlocks` identity pass       | per frame                   |
| markdown-prose       | `parseProse` / `inlineSegments` lexing                            | per dirty block per frame   |
| terminal-cells       | grapheme width measurement across script classes                  | innermost wrap leaf         |
| syntax-spans         | code fence and diff highlighting                                  | per visible fence per frame |
| markdown-split       | one-shot vs `StreamSplitScanner`, by tail shape + reducer fold    | per stream delta            |
| store-writes         | `UIStore.appendStream` / batched `printOutput`                    | per delta / per message     |
| stream-processor     | `StreamProcessor.process` over a synthetic provider stream        | per stream delta            |
| reasoning-parser     | `TagPairParser.feed`, passthrough vs `<think>` vs split tags      | per stream delta            |
| format-markdown      | one-shot `formatMarkdown` regex pipeline                          | per reply                   |
| token-counter        | `TokenCounter.countText`/`countMessage`, BPE vs ratio branches    | per message                 |
| context-window       | `ContextWindowManager.calculateTotalTokens`, BPE vs ratio         | per turn on long chats      |
| tool-result-clearing | `clearToolResults` walk, BPE vs ratio                             | per turn on long chats      |
| agent-prompt         | `buildSystemPrompt` cold vs cached + work-state preamble          | per turn / on resume        |
| summarizer-chunking  | `chunkForSummarizer` by history length and budget                 | per compaction              |
| conversation-log     | parse + reduce + `outputEntriesFromHistory`                       | session resume              |
| conversation-search  | `search` over a synthetic history directory                       | per keystroke while open    |
| tool-formatter       | `formatToolResult` at 1KB / 100KB / 1MB                           | per tool call               |
| capped-output        | `appendCapped` fold, `decodeCapped`, `tailForModel`               | per stdout chunk            |
| diff                 | `generateDiff` by file size and edit distance                     | per write / edit call       |
| activity-reducer     | `reduceEvent` fold over a recorded run                            | per stream event            |
| mcp-schema           | `convertMCPSchemaToZod` per tool and per 40-tool server           | per MCP connection          |
| startup              | `bun packages/runtime/src/main.ts --version` spawn, from source   | per invocation              |

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

## Not yet covered (mapped, worth adding)

- `StreamProcessor`'s `emit` is a no-op here, so the Effect stream's own
  queueing is out of scope — the suite measures the processor's share, not
  the whole pipeline's.
- Summarizer parse/apply helpers beyond `chunkForSummarizer`; the LLM call
  itself stays out of scope.
- Per-keystroke composer editing (`composer-edit`, `keymap`, `text-utils`)
  was measured and left out: each call is O(1) on a short buffer, so there is
  no signal to defend.
- The `grep`/`find` tools shell out to ripgrep, so their cost is process
  spawn (already covered by `startup`) plus I/O, not CPU worth pinning here.
