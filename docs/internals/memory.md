# Memory

**Reader job:** understand where agent memory lives on disk, how it stays safe, and why
it's opt-in rather than always-on.

Source:
[`services/memory-service.ts`](../../src/services/memory-service.ts) ·
[`interfaces/memory-service.ts`](../../src/core/interfaces/memory-service.ts) ·
[`tools/memory-tools.ts`](../../src/core/agent/tools/memory-tools.ts)

---

## What it is

A native, file-backed memory the agent manages itself via two tools — `view_memory` and
`manage_memory` (create/str_replace/insert/delete/rename) — mirroring the action surface of
Anthropic's own memory tool. There is no embedding index or vector search: memory is read in
full on `view`, which is the right tradeoff at the scale this targets (durable notes about
the people or projects one agent talks to), not a multi-tenant knowledge base.

Memory is scoped by `Agent.id`, the same identifier that already scopes conversation
history — so it follows an agent across every surface that invokes it (CLI, a Telegram
bridge, a Discord bridge), not by session or conversation.

## On disk

```text
~/.jazz/memory/<agentId>/            agent's memory root, created lazily on first write
~/.jazz/memory/<agentId>.lock/       directory-mutex, same convention as history's lock
```

Flat UTF-8 files, agent-organized (e.g. `people/alex.md`, `project-context.md`) — no
enforced schema. Guardrails cap depth, path-segment length, per-file size, total bytes, and
file count per agent (`core/constants/memory.ts`).

## Path safety

Every action goes through one function, `resolveMemoryPath`, before touching the
filesystem: it rejects `..`, null bytes, and absolute-path tricks, and **bans symlinks
outright** anywhere in the resolved chain — re-checked on every call, not cached, so a
same-run "create a file, swap it for a symlink, then read through it" race can't slip past a
one-time check.

Mutating actions (`create`/`str_replace`/`insert`/`delete`/`rename`) share one lock per
agent — not per file — because the size/count guardrails need a consistent view of the
whole directory tree, and the guardrail check plus the write happen inside the same lock
acquisition.

## Why opt-in

`view_memory`/`manage_memory` are registered like `file_management` or `git` — selected per
agent via `AgentConfig.tools`, not granted to every agent unconditionally. Memory persists
durable, potentially sensitive facts about a specific person to disk; forcing it on
everywhere would silently contradict personas (like `researcher`) that promise their tools
can't write files. Whoever wires up a persistent chat surface (Telegram, Discord) turns memory
on for that agent specifically.
