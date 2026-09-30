---
description: "Why Jazz memory learns only what you state, keeps tastes in scopes, separates standing rules from conditional ones, and stays in files you can read, correct, and forget."
---

# Why memory works this way

Memory is where Jazz learns how you like things done. These are the design choices behind it
and what each one gives you. For the mechanics, see
[Conversations, state, and memory](./conversations-and-memory.md).

## Memory learns what you said, not what the agent concluded

Every save carries an exact quote from one of your messages, identified by an id the host
assigned. Tool output, web pages, model summaries, and subagent prompts cannot establish a fact
about you, and secrets and sensitive claims are refused.

This gives you three things. A web page cannot plant a standing instruction. An agent cannot
talk itself into a preference. Every entry traces back to words you wrote, which
`jazz memory explain` shows.

The cost is deliberate: Jazz does not infer your taste from how you behave. It learns what you
tell it, including corrections such as "too formal".

## The agent decides when to remember

You do not have to say "remember". The agent saves a stated preference in the same turn, and a
second pass before compaction catches durable facts it missed. See
[How the agent learns](./conversations-and-memory.md#how-the-agent-learns).

The agent is conservative on purpose. Each standing entry is injected into every future turn
of every agent that reads the scope, so an uncertain fact is not saved. Keeping memory small
is what keeps it trustworthy and cheap to carry.

## A taste belongs to a context

How you write to a friend is not how you write to a colleague, and "run evals before merge" is
not advice for your cooking assistant. Memory is partitioned into named scopes, and an agent
reads and writes only the scopes it is configured for.

- `personal` is the default scope. A preference like concise replies follows you across your
  terminal agent, your Telegram bot, and your CI reviewer because all three read it.
- A project scope holds what applies only there.
- Two agents share context only by sharing a scope. Nothing is shared by accident.

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
- Only what you state is learned. Jazz does not infer preferences from your edits or choices.
- In-turn saving depends on the model following the save rule.

## Related

- [Conversations, state, and memory](./conversations-and-memory.md): the mechanics and commands
- [Agents](./agents.md): `memoryScopes` and the rest of the configuration
- [Skills](./skills.md): reusable procedures
