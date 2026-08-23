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

| suite           | measures                                                          | cadence in the app          |
| --------------- | ----------------------------------------------------------------- | --------------------------- |
| transcript-rows | `transcriptRows` cold wrap, warm streaming tail, fingerprint walk | per frame                   |
| blocks-from     | `blocksFrom` rebuild + `shareUnchangedBlocks` identity pass       | per frame                   |
| markdown-prose  | `parseProse` / `inlineSegments` lexing                            | per dirty block per frame   |
| terminal-cells  | grapheme width measurement across script classes                  | innermost wrap leaf         |
| syntax-spans    | code fence and diff highlighting                                  | per visible fence per frame |
| markdown-split  | `findLastSafeSplitPoint` by tail shape + cumulative stream fold   | per stream delta            |
| store-writes    | `UIStore.appendStream` / batched `printOutput`                    | per delta / per message     |
| format-markdown | one-shot `formatMarkdown` regex pipeline                          | per reply                   |

## Conventions

- Deterministic corpora only (`corpus.ts`) — no randomness, so runs on the same
  commit are comparable.
- One process per suite (`run.ts`) so module-level caches (wrap cache, glyph
  tables) never leak between suites.
- `harness.ts` pins `JAZZ_UI_GLYPHS=unicode`; benches that exercise chalk force
  `chalk.level = 3`. Both match a real terminal rather than a piped CI shell.
- Benches that depend on a module-level cache must control it explicitly (see
  the theme-variant toggle in `transcript-rows.bench.ts`).

## Not yet covered (mapped, worth adding)

- Token counting (`TokenCounter.countText`, BPE vs ratio branches) and the
  context trim ladder (`ContextWindowManager`) — per message.
- Conversation log parse/reduce (`parseConversationLog`) — session resume.
- Transcript search (`collectHits`) — per keystroke while search is open.
- Startup wall-clock (`bun src/main.ts --version` spawn timing) — needs a
  process-spawn harness, not a microbench.
