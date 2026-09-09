---
description: "Where Jazz agent memory lives on disk, how it stays safe across runs, and why memory is opt-in rather than always-on."
---

# Memory

This page explains where agent memory lives on disk, how it stays safe, and why
it's opt-in rather than always-on.

Source:
[`services/memory-service.ts`](../../packages/adapters/src/memory-service.ts) ·
[`interfaces/memory-service.ts`](../../packages/core/src/interfaces/memory-service.ts) ·
[`tools/memory-tools.ts`](../../packages/core/src/agent/tools/memory-tools.ts)

---

## What it is

A native, file-backed memory the agent manages itself via two tools — `view_memory` and
`manage_memory` (create/str_replace/insert/delete/rename) — mirroring the action surface of
Anthropic's own memory tool. There is no embedding index or vector search: memory is read in
full on `view`, which is the right tradeoff at the scale this targets (durable notes about
the people or projects one agent talks to), not a multi-tenant knowledge base.

## Scopes

Memory is partitioned into named **scopes** — `personal`, `finance`, `github-project-a` —
rather than one silo per agent. A scope is the unit of storage and is independent of agent
identity, so several agents can share one scope and a single agent can hold several.

An agent's accessible scopes come from `AgentConfig.memoryScopes`. An agent with none
configured falls back to a single scope named after its own id, which is why memory follows
an agent across every surface that invokes it (CLI, a Telegram bridge, a Discord bridge)
rather than being per-session or per-conversation.

Every tool path begins with a scope name (`personal/preferences.md`). Scopes are a strict
allowlist, not a namespace the agent can address freely: a path naming a scope outside the
caller's set is reported as not found. Renaming across scopes is refused.

Calling `view_memory` with no path lists every accessible scope **and the files inside them**,
so one call is enough to see what has been saved. Listing the root never creates a scope
directory — an unwritten scope shows up as an empty one.

## On disk

```text
~/.jazz/memory/<scope>/            scope's memory root, created lazily on first write
~/.jazz/memory/<scope>.lock/       directory-mutex, same convention as history's lock
```

Flat UTF-8 files, agent-organized (e.g. `people/alex.md`, `project-context.md`) — no
enforced schema. Guardrails cap depth, path-segment length, per-file size, total bytes, and
file count per scope (`core/constants/memory.ts`). The per-file cap is checked on every
write; the scope-wide byte and file-count caps are checked on every write that grows the
scope, with an edit charged only its net delta so a shrinking edit always fits.

## Provenance

Every write records who made it, when, and when the file was last read back, in a hidden
per-scope sidecar (`.provenance.json`). It is a sidecar rather than a header inside the
memory files because those files are both the artifact a person edits directly and exactly
what reaches the model — a header would break that equivalence and shift every line number
`str_replace` and `insert` address. Hidden entries are excluded from listings and from the
byte and file-count budgets: Jazz's own bookkeeping must not consume the operator's quota.

`lastViewedAt` is recorded but deliberately wired to nothing. Personal memory is not
re-derivable — delete "allergic to shellfish" and it is gone — so "unused" is a bad proxy
for "unimportant": an allergy is read once a year. The signal exists for a human reviewing
memory, not for an automatic deleter.

## Seeing and controlling it

```text
jazz memory list <agent>            every file the agent can read, with provenance
jazz memory show <agent> <path>     one file, exactly as the agent reads it
jazz memory forget <agent> <path>   delete one file permanently
jazz memory recall [--surface]      how often runs consulted memory before answering
```

`/memory` does the same inside a chat session (`/memory <path>` to read one, `/memory forget
<path>` to remove one). Both operate on the real files, so nothing shown is a regenerated
summary that could differ from what the model actually receives.

## Measuring recall

`view_memory` is tool-call-gated with no preload: nothing injects memory into context, so
whether a run has continuity depends on the model choosing to spend a call before it
answers. That is a property of a surface, not something a unit test can settle — a casual
opener on a chat bridge is both the likeliest miss and the least likely to be noticed.

Each finished run appends one line to `~/.jazz/memory-recall/memory-recall.jsonl` recording
whether a `view_memory` call landed before the first substantive answer, tagged with the
surface it came through. Bots shell out to the same `jazz run` a terminal user invokes, so
each bridge sets `JAZZ_SURFACE`; absent the marker a run is plain CLI. Runs never offered the
memory tools are recorded too, and excluded from the denominator — they cannot be a miss.
`jazz memory recall` reports the rate per surface.

## Path safety

Every action goes through one function, `resolveMemoryPath`, before touching the
filesystem: it rejects `..`, null bytes, and absolute-path tricks, and **bans symlinks
outright** anywhere in the resolved chain — re-checked on every call, not cached, so a
same-run "create a file, swap it for a symlink, then read through it" race can't slip past a
one-time check.

Mutating actions (`create`/`str_replace`/`insert`/`delete`/`rename`) share one lock per
scope — not per file — because the size/count guardrails need a consistent view of the
whole directory tree, and the guardrail check plus the write happen inside the same lock
acquisition.

## Why opt-in

`view_memory`/`manage_memory` are registered like `file_management` or `git` — selected per
agent via `AgentConfig.tools`, not granted to every agent unconditionally. Memory persists
durable, potentially sensitive facts about a specific person to disk; forcing it on
everywhere would silently contradict personas (like `researcher`) that promise their tools
can't write files. Whoever wires up a persistent chat surface (Telegram, Discord) turns memory
on for that agent specifically.

Ephemeral runs (`jazz run --ephemeral`, `/incognito` in the bots) withhold `manage_memory`
entirely, so nothing from that conversation reaches long-term memory.
