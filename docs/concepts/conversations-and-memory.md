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

In a later conversation, those preferences can apply without repeating them. You do not have
to say "remember": the agent [decides when a fact is worth keeping](#how-the-agent-learns) as
the conversation goes. Ask it to forget a preference when it no longer applies, or
[review saved memory from the CLI](#cli-access).

## Types of state

Jazz keeps five kinds of state:

| Kind                     | Written by                     | Scope            | Survives                |
| ------------------------ | ------------------------------ | ---------------- | ----------------------- |
| **Conversation history** | the runtime, every turn        | one conversation | forever, until archived |
| **Work state**           | the model, `update_work_state` | one conversation | compaction              |
| **Todos**                | the model, `manage_todos`      | one conversation | compaction              |
| **Scratchpad**           | the model, `manage_scratchpad` | one agent        | forever, until deleted  |
| **Memory**               | the model, `manage_memory`     | one memory scope | forever, until deleted  |

## Conversation history

Conversation history contains your messages, the agent's replies, and its tool results.
In the terminal, use `/resume` to return to earlier work and `/new` for a new conversation.

To delete a conversation, highlight it in the `/resume` list, press Ctrl+D, and confirm with
Enter (Esc keeps it). Deleting removes its history, its archived copy, its working state and
logs, and the screenshots taken in it. Jazz refuses while something still uses the conversation:
the chat you are in, another open chat, a turn that is running, a goal or loop still working in
it, a run still working or waiting for your answer, a scheduled wake-up, or background work
still reporting back to it. A run waiting for your answer is named in the message: answer it,
or drop it with `jazz runs cancel <run id>`. A run whose answer deadline passed no longer counts.

`/switch` moves the conversation to the agent you pick and is refused for the same reasons, with
one difference: background jobs that already finished but have not reported back yet move with
the conversation, and report to the new agent. Only jobs still running keep it where it is.

A save only ever adds to a conversation; nothing said in it is removed or hidden. `/retry` and
editing an earlier message start a branch, and the answer they replace stays in the
conversation. Use `/tree` to switch to another branch or to rewind and edit one of your earlier
messages.

One turn runs at a time on a conversation. If another terminal, a goal, or a background wake-up
is already running a turn on it, your message waits ("busy in another session") and then
continues from what that turn saved, so the conversation stays one conversation.

In scripts, pass the same `--conversation` value to continue a thread:

```bash
jazz run --agent assistant --conversation release-plan "Help me plan the next release"
jazz run --agent assistant --conversation release-plan "Update the plan: the launch is Friday"
```

Without a conversation key, each `jazz run` starts a separate thread.

As context fills, Jazz summarizes older messages for the model. The original messages stay in
the conversation's history and in search; the model works from the summary. Use work state and
todos to preserve important task details through compaction.

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
- **`<scope>/when/<topic>/<slug>.md`** — in force for the situation its topic names, such as
  `writing-to-friends` or `sending-email`. It is listed in the prompt on every turn.

You can edit or delete these files directly.

### Sharing memory between agents

Memory is shared by every agent. A scope is a topic, not an ownership boundary: every agent can
read and write every scope, and any agent can create a new scope when a conversation calls for
one, so a lesson learned with one agent is immediately available to all of them. A preference
like "concise replies" in `personal` follows the person across their terminal agent, their
Telegram bot, and their CI reviewer. Scopes are discovered from the memory directory — what
exists is what is visible — and `jazz memory list` shows the whole landscape.

### Recalling memory

Every entry is in front of the agent on every turn, with no lookup needed. Entries in `always/`
are listed under **Preferences**. Entries in `when/` are listed under **Situational
preferences**, each tagged with the situation its topic names. The agent applies every entry that
matches the task, and several can apply at once. A request to email a friend can use both a
`writing-to-friends` entry and a `sending-email` entry.

Nothing is truncated, however many entries there are. The agent can read an entry in full with
`view_memory`.

When the agent saves something, it names the topic after the situation the entry applies to, so a
request worded differently from your original statement still matches it. If you write entries by
hand, name the topic directory the same way: `writing-to-friends`, not `communication`.

`jazz memory recall` reports, per surface, how often the agent also looked something up before
answering and how many entries were injected per run.

### How the agent learns

Memory is gathered in two passes, both automatic. During the conversation the agent saves
directly; what a background pass picks waits for your review, as do lessons the agent proposes
from its own mistakes.

**During the conversation.** When you state a preference, opinion, relationship, or personal
fact ("I'm allergic to shellfish", "I prefer dark mode"), or correct how it did something ("too
formal", "make it shorter"), the agent saves it in the same turn with `manage_memory`, without
waiting to be asked. Before it answers or acts on a request that
your preferences or history could shape, it checks memory with `view_memory`. For each
candidate fact it weighs:

- **Did you state it?** Only your own words count. What the agent inferred does not.
- **Will it still be true later?** Durable preferences and facts qualify. Task state, in-progress
  work, and small talk do not.
- **Is it sensitive?** Secrets, credentials, and sensitive claims are never saved.
- **When should it apply?** An `always` entry is for instructions that shape nearly every task,
  such as a preference for concise replies. Everything else is filed under a topic in `when/`
  named for the situation it applies to, so a favorite fruit can inform a shopping list without
  entering unrelated requests.
- **Which scope?** `personal` by default, or a topic scope when the fact clearly belongs to one
  situation, project, or domain.
- **Is it worth the cost of being wrong?** Every `always` entry is injected into every future
  turn of every agent, so when the agent is unsure a fact is durable, it does not save it. You
  can still ask it to remember something explicitly.

How consistently an agent follows this depends on the model.

**At compaction.** When a conversation grows long enough that Jazz must
[summarize older messages](./context-management.md), a separate extraction pass first reads the
messages about to be folded away and picks durable facts you stated that the agent had not
already saved. It also reads the rest of the conversation (the earlier summary and the newer
messages that stay verbatim) as context it cannot quote, so it can tell a lasting preference from
an instruction for the task at hand, and skip anything you later took back. It reads existing
memory first, does not duplicate an entry that already covers the fact, and amends an entry that
has gone stale. Saving nothing is the common outcome.

Nothing this pass picks is saved straight away: each pick waits for review alongside lessons
(see below), and the turn ends with a line saying how many are waiting. The pass is one extra
model call, and its cost counts toward the run's caps. A manual `/compact` does not run it.

Both passes can write only what they can quote from your messages (see below), and neither runs
when persistence is off: `--ephemeral` on `jazz run` or `jazz agent chat`, or a run answering a peer.

### Lessons from the agent's own mistakes

When the agent changes course because it got something wrong (it withdraws a recommendation,
you or a search show its approach was mistaken, or a check it skipped would have caught the
problem), it proposes a lesson with `propose_lesson`: a general rule, and the mistake it
prevents. You do not have to say "remember".

A lesson is written in the agent's words, not yours, so it is not saved on the agent's say-so.
It waits for review, together with the facts the compaction pass picked:

- `/memory review` in a chat, or `jazz memory review` from the shell, lists everything waiting
  and opens one checklist. Check what to keep and press Enter: checked items are saved and the
  rest are dropped. Escape decides nothing and leaves them all waiting.
- `/memory accept <id>` and `/memory reject <id>` (or `jazz memory accept|reject <id>`) decide
  one item at a time, which also works where Jazz cannot show a checklist.
- A chat opens with a line saying how many suggestions are waiting.

No tool can accept a suggestion. `jazz memory review` and `jazz memory accept` refuse commands
started by an agent, so a shell tool cannot approve its own proposal. An accepted lesson is filed
like any other entry, under the situation it applies to, and `jazz memory explain` shows its
origin as `lesson`; a kept fact shows `auto`. A kept amendment is refused if the entry changed
since it was suggested, and stays waiting.

The same review happens after a conversation ends. When you close a chat or switch away from
a conversation, Jazz starts a background process that reads what was said since the last
review, with the rest of the conversation as context, and suggests facts and lessons the same
way. You do not wait for it, and it never asks for approval. Its suggestions appear at your next
chat. It does not run
for `--ephemeral` chats. A chat started with `--config` passes that same config file to the
background process, retaining its agent store and provider settings.

### Learning on demand with `/learn`

`/learn` (or `/reflect`) runs that review now, mid-conversation, and then tidies memory:

1. It shows what memory gained, changed, and lost since the chat started, from any agent or
   from your own `/memory forget`.
2. It reads what was said since the last review and suggests facts and lessons, like the pass
   that runs when a chat closes. Closing the chat afterwards does not suggest them again.
3. It reviews the store as a whole with those changes in hand and suggests removing entries
   that another entry already covers, that you later contradicted, or that no longer hold, and
   rewriting lessons that are too narrow or that cover the same situation. Your own facts are
   never reworded; only lessons are.
4. It opens the `/memory review` checklist with every suggestion at once, including any that
   were already waiting.

A kept removal is refused if the entry changed since it was suggested, and stays waiting. Like
the other passes, `/learn` changes nothing until you keep a suggestion, and does nothing in an
`--ephemeral` chat.

Memory holds facts and preferences. It does not turn a procedure the agent worked out into a
reusable [skill](./skills.md).

### Saving, correcting, and forgetting

Every save must quote your message, apart from a lesson you accepted. Tool output, web pages,
model summaries, and synthetic subagent prompts cannot establish facts about you. Secrets and
sensitive claims are refused. A request to remember at the start of a quote ("keep in mind
that …", "remember to …") is left out of the saved entry, so it states the rule itself.

To correct an entry, tell the agent what changed. To remove one, ask it to forget that
specific fact. Jazz also revokes the quoted source so later compaction cannot save the
same statement again. Older memories created before source tracking may require you to
review their original conversation history.

### CLI access

Memory is shared by every agent, so the commands address scopes and paths directly — there is no
agent argument to select a per-agent view:

```bash
jazz memory list
jazz memory list personal
jazz memory show personal/always/concise-replies.md
jazz memory explain personal/always/concise-replies.md
jazz memory forget personal/always/concise-replies.md
```

`list` with no argument shows every scope on disk; `list <scope>` drills in. `show` prints the
saved entry. `explain` shows its provenance and recent records of whether it was available to
model requests; those records do not prove the model used it successfully. `forget` deletes the
entry. Because scopes are shared, a change here affects every agent.

## Choosing what to keep

- Continue a discussion in the same **conversation**.
- Use **work state** and **todos** for the current task's decisions and progress.
- Save long drafts and research material in the **scratchpad** or a file.
- Use **memory** for preferences and facts needed in future conversations.

## Related

- [Why memory works this way](./memory-design.md): the design choices behind what Jazz learns
- [Context management](./context-management.md): how history is summarized and findings survive
- [Lexicon](./lexicon.md): the precise word for each of these
- [Agents](./agents.md): the rest of the agent configuration
