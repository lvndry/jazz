---
description: "The five kinds of state a Jazz agent carries, who writes each one, and how long it lasts."
---

# Conversations, state, and memory

A conversation keeps the context for one thread of work. Resume it to continue a task,
or start a new one for a separate topic. Memory carries your preferences and facts into
future conversations.

For example, tell your agent:

```text
Remember that I prefer concise replies and use Europe/Paris as my timezone.
```

In a later conversation, those preferences can apply without repeating them. Ask it to
forget a preference when it no longer applies, or [review saved memory from the CLI](#cli-access).

## Types of state

Jazz keeps five kinds of state:

| Kind                     | Written by                     | Scope            | Survives                  |
| ------------------------ | ------------------------------ | ---------------- | ------------------------- |
| **Conversation history** | the runtime, every turn        | one conversation | until compaction trims it |
| **Work state**           | the model, `update_work_state` | one conversation | compaction                |
| **Todos**                | the model, `manage_todos`      | one conversation | compaction                |
| **Scratchpad**           | the model, `manage_scratchpad` | one agent        | forever, until deleted    |
| **Memory**               | the model, `manage_memory`     | one memory scope | forever, until deleted    |

## Conversation history

Conversation history contains your messages, the agent's replies, and its tool results.
In the terminal, use `/resume` to return to earlier work and `/start` for a new conversation.

In scripts, pass the same `--conversation` value to continue a thread:

```bash
jazz run --agent assistant --conversation release-plan "Help me plan the next release"
jazz run --agent assistant --conversation release-plan "Update the plan: the launch is Friday"
```

Without a conversation key, each `jazz run` starts a separate thread.

As context fills, Jazz summarizes older messages. Use work state and todos to preserve
important task details through compaction.

## Work state

The agent's account of what it is doing: the goal, the constraints, what it has decided, what is
still open, what it means to do next. One per conversation, discarded when the work ends.

Work state is stored as JSON and survives compaction.

Work state is written by the model and may be stale. It does not report whether the run is
active, parked, or complete.

## Todos

The list of work, with status and priority, rendered in the interface. Work state has no
separate work list.

A todo records verification evidence in `verifiedBy`, separately from its status.

## Scratchpad

Durable scratch space, per agent, across every conversation. Large working drafts, research
dumps, intermediate artifacts: the things too big or too provisional for memory.

For large material worth keeping, save it in the scratchpad and reference its path from memory.

Bounded so a runaway agent cannot fill the disk: 5 MB per file, 2,000 files, and 1 GB per agent
by default, which `workspaceMaxTotalBytesPerAgent` overrides.

---

## Memory

Memory saves preferences and facts for future conversations, such as your timezone or
preferred response length. Agents can share it through memory scopes.

### Memory files

```text
~/.jazz/memory/
  personal/always/concise-replies.md
  personal/when/cooking/no-cilantro.md
  github-jazz/always/run-evals-before-merge.md
```

Each entry is a Markdown file. Its directory determines when it applies:

- **`<scope>/always/<slug>.md`** — in force on every turn, injected automatically.
- **`<scope>/when/<topic>/<slug>.md`** — in force when the agent discovers it via `view_memory`.

You can edit or delete these files directly.

### Sharing memory between agents

The default scope is `"personal"` — shared by every agent unless overridden with `memoryScopes`
in the agent config. A preference like "concise replies" follows the person across their
terminal agent, their Telegram bot, and their CI reviewer, because all three read the same
scope.

Scopes are an allowlist. An agent can only read and write the scopes it is configured for. Two
agents that should share durable context share a scope; two agents that should not, don't.

### Recalling memory

Entries in `always/` are included every turn. The agent uses `view_memory` to find and read
relevant entries under `when/`. An entry there may go unused if the agent does not look it up.

### Saving, correcting, and forgetting

The agent can save what you explicitly tell it, using an exact quote from your message.
Tool output, web pages, model summaries, and synthetic subagent prompts cannot establish
facts about you. Secrets and sensitive claims are refused.

To correct an entry, tell the agent what changed. To remove one, ask it to forget that
specific fact. Jazz also revokes the quoted source so later compaction cannot save the
same statement again. Older memories created before source tracking may require you to
review their original conversation history.

### Automatic extraction at compaction

Before compaction, Jazz checks the older messages for durable facts you stated and can
save them to memory. It excludes inferred preferences, task progress, and small talk.

See [Context management](./context-management.md) for when compaction happens.

### CLI access

Replace `assistant` with your agent's name:

```bash
jazz memory list assistant
jazz memory show assistant personal/always/concise-replies.md
jazz memory explain assistant personal/always/concise-replies.md
jazz memory forget assistant personal/always/concise-replies.md
```

`show` prints the saved entry. `explain` shows its provenance and recent records of whether
it was available to model requests; those records do not prove the model used it successfully.
`forget` deletes the entry. Shared-scope changes affect every agent using that scope.

## Choosing what to keep

- Continue a discussion in the same **conversation**.
- Use **work state** and **todos** for the current task's decisions and progress.
- Save long drafts and research material in the **scratchpad** or a file.
- Use **memory** for preferences and facts needed in future conversations.

## Related

- [Context management](./context-management.md): how history is summarized and findings survive
- [Lexicon](./lexicon.md): the precise word for each of these
- [Agents](./agents.md): `memoryScopes` and the rest of the configuration
