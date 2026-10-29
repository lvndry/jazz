---
description: "Why Jazz memory learns what you state and the lessons you accept, keeps tastes in scopes, and stays in files you can read, correct, and forget."
---

# Why memory works this way

Memory is where Jazz learns how you like things done. These are the design choices behind it
and what each one gives you. For the mechanics, see
[Conversations, state, and memory](./conversations-and-memory.md).

## Memory is a summary backed by what you said

Each entry opens with one sentence that sums up what the conversation established, written so it
reads on its own: "Runs a pre-seed startup hiring engineers from junior to principal; the bar is
raw intelligence." A quote taken out of its conversation loses who and what it was about, so the
summary carries that context and is the line recall shows.

Under the summary, one or more `The user said:` lines hold exact quotes from your messages, each
identified by an id the host assigned. A save needs at least one, and every quote must check out.
Tool output, web pages, model summaries, and subagent prompts cannot establish a fact about you,
and secrets and sensitive claims are refused, in the summary as well as in the quotes.

This gives you three things. A web page cannot plant a standing instruction. An agent cannot
talk itself into a preference. Every entry traces back to words you wrote, which
`jazz memory explain` shows.

The cost is deliberate: Jazz does not infer your taste from how you behave. It learns what you
tell it, including corrections such as "too formal".

## The agent proposes lessons; you decide

The one entry memory holds without a quote from you is a lesson from the agent's own mistake, such as
"search for existing products before proposing to build one". You should not have to say
"remember" for the agent to learn from a mistake it just corrected, so it proposes the rule
without being asked, during the conversation and in a background pass after the conversation
ends.

A proposal is not a save. It waits until you accept it with a command you type, and no tool can
accept one. That keeps the guarantee above: a web page can at most get a lesson proposed, and you
read it before anything is saved.

## The agent decides when to remember

You do not have to say "remember". The agent saves a stated preference in the same turn, and a
second pass before compaction catches durable facts it missed. See
[How the agent learns](./conversations-and-memory.md#how-the-agent-learns).

The agent is conservative on purpose. Each standing entry is injected into every future turn of
every agent, so an uncertain fact is not saved. Keeping memory small is what keeps it
trustworthy and cheap to carry.

## A taste belongs to a context

How you write to a friend is not how you write to a colleague, and "run evals before merge" is
not advice for your cooking assistant. Memory is partitioned into named scopes, which are
topics — not ownership boundaries. Every agent reads and writes every scope, and any agent can
create a scope when a conversation calls for one, so a lesson learned with one agent is
available to all of them.

- `personal` is the default scope. A preference like concise replies follows you across your
  terminal agent, your Telegram bot, and your CI reviewer because they all share it.
- A project scope holds what applies only there.
- Scopes are discovered from the memory directory, not configured per agent: what exists is
  what is visible to everyone, and `jazz memory list` shows the whole landscape.

## Pay for context only where it applies

An entry under `always/` shapes nearly every task, so it is injected on every turn. An entry
under `when/<topic>/` applies to a kind of task and is read when the agent looks it up. That
split keeps the standing instructions short without losing the specific ones.

## Memory is files you can read, edit, and delete

Entries are Markdown files under `~/.jazz/memory/`. You can open them, change them, or delete
them directly, or use `jazz memory list`, `show`, `explain`, and `forget`. `explain` shows an
entry's provenance and recent records of whether it was available to model requests. Those
records show availability, not that the model used the entry well.

## Forgetting sticks

Forgetting an entry also revokes the quoted source, so later compaction cannot save the same
statement again. Memories created before source tracking may require you to review their
original conversation history.

## What memory is not for

Memory holds small facts and preferences, each one a thought you can audit. It is not for large
working material, which belongs in the [scratchpad](./conversations-and-memory.md#scratchpad),
and it does not turn a procedure the agent worked out into a reusable
[skill](./skills.md). Skills are instructions you write or install.

## Known limits today

- An entry under `when/` reaches the model when the agent looks it up. `jazz memory recall`
  reports how often a lookup happens before the first answer, per surface.
- Only what you state, and lessons you accept, is learned. Jazz does not infer preferences from
  your edits or choices.
- In-turn saving depends on the model following the save rule.

## Related

- [Conversations, state, and memory](./conversations-and-memory.md): the mechanics and commands
- [Agents](./agents.md): the rest of the agent configuration
- [Skills](./skills.md): reusable procedures
