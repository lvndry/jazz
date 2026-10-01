---
description: "Verify Jazz's actual native ANSI output against an independent terminal grid, including stale cells, resizing, Unicode widths, and input routing."
---

# Verifying terminal output

The fullscreen renderer has two observable grids: OpenTUI's intended buffer and
the terminal grid produced by interpreting its emitted bytes. A correct intended
buffer does not establish that the terminal displays it. Tests must distinguish
document/viewport failures from output that leaves stale physical cells.

Source: [terminal oracle](../../packages/cli/src/ui/fullscreen/testing/terminal-oracle.ts)
and [regressions](../../packages/cli/src/ui/fullscreen/testing/terminal-oracle.test.tsx).

## Native output oracle

`createTerminalOracle({ width, height })` mounts a real OpenTUI native writer and
React root on custom streams. It does not acquire the person's TTY. The output
bytes feed `@xterm/headless`, an independent terminal implementation.

`render(node)` publishes the next scene. Await `flush()` before inspecting output.
`compareGrid()` compares the interpreted terminal against `currentRenderBuffer`,
including blank cells, grapheme text, wide characters, and continuation widths.
It reports only mismatching coordinates; diagnostic errors never echo scene text.
Always call `dispose()` in `finally` to release the React root, native renderer,
streams, and observer.

The oracle deliberately supports `writeTerminal(bytes)` for fault injection.
Writing a stale character into the interpreted terminal leaves the intended
buffer unchanged. An ordinary incremental frame can leave that corruption
visible; a full repaint must replace both stale text and a corrupted blank cell.
This self-test establishes that buffer-only assertions cannot satisfy the oracle.

`input(bytes)` sends raw key and wheel sequences through the native input parser.
`resize(width, height)` drains preceding output before changing emulator geometry
and resizing the renderer. Re-render the scene with its new layout inputs after
resizing.

## Run it

```bash
bun test packages/cli/src/ui/fullscreen/testing/terminal-oracle.test.tsx
```

The fixtures are synthetic and cover receipt bursts, answer settlement and
shrinkage, narrow/wide resizing, combining characters, CJK widths, raw input, and
stale-grid recovery. Do not copy a private conversation into a checked-in fixture.

The oracle currently compares character content and cell width. It does not
establish foreground/background attributes, fonts, hyperlinks, host compositor
behavior, or PTY transport correctness. Compiled-binary PTY qualification and
actual terminal checks complement it.

The [compiled PTY qualifier](../../packages/cli/src/ui/fullscreen/testing/pty-session.test.ts)
mounts the production store, bridge, and runtime inside a compiled fixture. It
holds history through receipt bursts, follows End across two turns, types into
the composer, attempts a foreign clear, resizes, and compares the independent
terminal grid before exiting. Run it with:

```bash
bun test packages/cli/src/ui/fullscreen/testing/pty-session.test.ts
```

The fixture does not launch a provider or use a person's Jazz home. Whole release
CLI startup is qualified separately by `bench/startup.bench.ts`. See the
[runtime contract](./terminal-runtime.md) for trusted output boundaries and the
pinned backend upgrade gates.

## Benchmarks

`createVtObserver(columns, rows)` is reusable by a native-output benchmark sink.
`accept(bytes)` copies borrowed feed memory immediately; `drain()` interprets it
at an explicit observation boundary. Capture or resize only after draining.

Keep terminal-emulator interpretation outside the timed production paint sample.
Validate the emitted grid after the sample, while measuring renderer commit time,
output bytes, and resource usage separately. The observer proves ANSI semantics;
it does not measure a terminal's GPU presentation latency.

See [benchmark workloads and budgets](../../bench/README.md) and
[testing and evaluation](./testing-and-evals.md).
