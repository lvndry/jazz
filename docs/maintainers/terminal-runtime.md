---
description: "Maintain Jazz's single terminal writer, demand frames, renderer capabilities, cleanup, and fallback contracts."
---

# Terminal runtime

[Mount](../../packages/cli/src/ui/fullscreen/mount.ts) acquires the terminal and
its cleanup scope. [Attach](../../packages/cli/src/ui/fullscreen/attach.tsx)
connects React and input handlers. Their handle exposes release, invalidation,
and title capabilities rather than handing ordinary producers a terminal writer.

While fullscreen owns the terminal, ordinary `process.stdout.write` and
`process.stderr.write` calls cannot emit terminal controls. Sanitized diagnostic
text enters the presentation source; control-only and reentrant writes are
suppressed. The native writer captures its privileged stream before interception.
Clipboard and title changes use explicit renderer capabilities. Synchronous
terminal-background acquisition and restoration remain scoped OSC effects.
Direct native file-descriptor writes and child processes inheriting the terminal
are trusted boundaries, not intercepted JavaScript stream calls.

## Frames and invalidation

React commits and native mutations request demand frames. The runtime does not
call `renderer.start()` to run an unconditional frame loop. Job-control resume
preserves idle scheduling and requests a repair frame. An idle screen therefore
does not require a periodic transcript repaint.

`invalidate()` requests a full physical repaint, including blank cells. A normal
incremental render only compares intended buffers and cannot repair arbitrary
foreign screen corruption. [Renderer adapter](../../packages/cli/src/ui/fullscreen/renderer-adapter.ts)
isolates the private repaint flag and native failure observation required by
OpenTUI 0.5.11. The dependency versions are exact pins. A changed backend contract
fails acquisition explicitly rather than silently weakening repair or fallback.

Before upgrading OpenTUI, run the independent native-output oracle, renderer
adapter tests, native input/selection tests, and compiled PTY qualifier. Check
idle demand scheduling, blank-cell repair, backpressure, and native failure
notification. Update the adapter and pins together if the contract changes.

## Failure and cleanup

Startup failures release every acquired resource. React rendering, committed
handler failures, native frame failures, and capability failures enter one
scheduled teardown path and fall back once. Retrying native output because of
backpressure is not a fatal error. Fallback projects the current source document;
it does not replay actions or restart a provider request.

[Cleanup scope](../../packages/cli/src/ui/fullscreen/terminal-scope.ts) releases
resources in reverse acquisition order, continuing even if a release throws.
Stream methods, input handlers, lifecycle listeners, terminal effects, React,
and native resources belong to that scope. Releases are idempotent. Jazz's
fallback diagnostic identifies failure without echoing conversation content.
The pinned React reconciler also has its own console error callbacks; its public
root API does not expose a replacement for those diagnostics.

## Qualification

The [terminal-output oracle](./terminal-rendering-tests.md) interprets real native
bytes through an independent terminal implementation. The compiled PTY fixture
mounts the production source, bridge, and runtime with synthetic local facts;
it verifies two turns, Page Up/End, typing, foreign controls, resize, and exit.
This fixture is not the whole release CLI. `bench/startup.bench.ts` separately
launches the built release binary with temporary credential-free homes and
measures first paint and accepted typed drafts for fullscreen and classic modes.

These checks qualify ANSI semantics and input transport. They do not establish
host-terminal font, compositor, or GPU behavior. Keep resource measurements
separate from correctness assertions and use the existing benchmark budgets.
