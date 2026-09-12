---
description: "The five kinds of state a Jazz agent carries, who writes each one, how long it lasts, and which one to reach for when work has to survive something."
---

# Conversations, state, and memory

Jazz keeps five kinds of state, and they are separate on purpose. Collapsing any two of them
produces the same failure: something that mattered gets discarded, or something that stopped
being true gets carried forever.

| Kind                     | Written by                     | Scope            | Survives                  |
| ------------------------ | ------------------------------ | ---------------- | ------------------------- |
| **Conversation history** | the runtime, every turn        | one conversation | until compaction trims it |
| **Work state**           | the model, `update_work_state` | one conversation | compaction                |
| **Todos**                | the model, `manage_todos`      | one conversation | compaction                |
| **Scratchpad**           | the model, `manage_scratchpad` | one agent        | forever, until deleted    |
| **Memory**               | the model, `manage_memory`     | one memory scope | forever, until deleted    |

## Conversation history

The transcript: user, assistant, and tool messages in order. Interactive chat keeps one active
conversation. Headless callers opt in with a stable `--conversation` key, which is what gives a
chat bridge per-chat memory without the bridge storing anything itself. Without a key, a one-shot
run is stateless.

History is not permanent. When the context fills, older messages are summarized and the detail
in them is gone. That is what the next two exist to survive.

## Work state

The agent's account of what it is doing: the goal, the constraints, what it has decided, what is
still open, what it means to do next. One per conversation, discarded when the work ends.

Its job is to survive compaction. History records what was said; work state records _intent_,
which only the agent knows and only while it still holds it in context. Written as JSON rather
than prose because it is edited repeatedly, and models patch structured documents far more
reliably than they rewrite paragraphs.

**Work state is subjective; a run is objective.** Work state is the agent's diary and can be
stale or wrong. A run's state is a fact about a process. The two can disagree without either
being broken: a model can be planning its next step while the run it is planning inside has
already parked, waiting for an approval.

## Todos

The list of work, with status and priority, rendered in the interface. Work state deliberately
holds no second list, because carrying one left the model guessing which to update.

One field is worth knowing about: a todo records `verifiedBy`, so a completed item with nothing
in it says plainly that the work was written but never checked. Progress and evidence stay
separate, because "unverified" is not a stage of work and a status enum is the wrong place for it.

## Scratchpad

Durable scratch space, per agent, across every conversation. Large working drafts, research
dumps, intermediate artifacts: the things too big or too provisional for memory.

The convention that keeps both useful is to reference a scratchpad path from a memory entry once
the work is done, rather than copying the content into memory. Memory stays small and curated;
the bulk lives where bulk belongs.

Bounded so a runaway agent cannot fill the disk: 5 MB per file, 2,000 files, and 1 GB per agent
by default, which `workspaceMaxTotalBytesPerAgent` overrides.

## Memory

Facts that stay true _between_ conversations, split into named scopes so an agent reaches only
what it should. Something true of the person regardless of what they are doing belongs in a
personal scope; something true only inside one project belongs in that project's.

Agents read and write permitted scopes themselves. You can inspect and prune with `jazz memory
list`, `jazz memory show`, and `jazz memory forget`.

## Choosing

Ask how long it has to be true.

- True for this exchange only: **history** already has it.
- True until this task is done, and must survive compaction: **work state** for intent, **todos**
  for the list.
- Too big to re-derive, useful later, not a fact about anyone: **scratchpad**.
- Still true in three weeks, and would make a later answer better: **memory**.

## Related

- [Context lifecycle](../maintainers/context-lifecycle.md): how the runner injects each one, and
  what compaction does
- [Lexicon](./lexicon.md): the precise word for each of these
- [Agents](./agents.md): `memoryScopes` and the rest of the configuration
