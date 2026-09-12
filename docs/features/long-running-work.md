---
description: "How Jazz keeps a long agent run useful: budget pressure, compaction at 80%, turn-aware trimming, work state, tool-result offloading, and meltdown detection."
---

# Long-running work

Long work fails in three ways. The agent loses the task, repeats itself, or hits a hard limit
with nothing to show.

All three are harness problems, not prompting problems. A model cannot fix them from inside the
conversation it is losing.

## The ladder, in order of when it fires

| At                                             | What happens                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| 50/80/90% of a cost, token, or duration budget | The model is told, and asked to consolidate                        |
| 70/90% of the iteration budget                 | Same, on the iteration axis                                        |
| 70% of the context window                      | The model is warned that older history will be summarized          |
| 80% of the context window                      | Compaction: the middle is summarized, system and recent turns kept |
| 95% of the context window                      | Trimming: whole turns dropped, never mid-tool-call                 |

Every warning is ephemeral. It goes into one request and is never stored.

Store them and by iteration 78 the history carries eight escalating FINISH NOW messages. They
cost tokens, contradict each other, and poison the summarization they were warning about.

## Compaction keeps the beginning

A sliding window is the obvious design and the wrong one. It drops the oldest messages, and that
is where the task and the plan live.

Forty minutes in, you would keep a tool result about page 14 of a PDF and lose the reason you
were reading it.

So compaction summarizes the middle instead, and rebuilds as `[system, summary, recent turns]`.

It costs an extra model call and loses real detail. That is why it is visible rather than silent,
why `summarizerModel` lets you point it at something cheap, and why the agent can trigger it
itself with `summarize_context` when it knows it needs room.

Trimming below that is coarser, and protects one invariant absolutely: an assistant message's
`tool_calls` and its `tool` results move together.

Split them and most providers reject the request. The 400 arrives several iterations later, far
from the cause.

## What survives compaction

Detail is lost when history is summarized. Three things are designed to outlive it:

- **[Work state](../concepts/conversations-and-memory.md)** holds the objective, decisions, open
  questions, and next step. History records what was said; work state records intent, which is
  the half only the agent knows.
- **Todos** hold the list of work and its verification status.
- **Offloaded tool results** move to the conversation's work directory, replaced in context by a
  pointer the model can call `retrieve_tool_result` on. Every iteration, not at a fill threshold:
  a 200k model was otherwise carrying 130k of already-read file output on every round trip.

The rule: a conclusion worth keeping goes into work state, a todo, or a file. One that lives only
inside a large tool result is one you are trusting compaction with.

## Meltdown detection

Over the last 10 tool calls, if unique `name:arguments` keys fall below 40%, the agent is told it
is looping and the window resets.

It keys on name _and_ arguments on purpose. Counting tool names alone would flag
`web_search → web_fetch → web_search`, which is what research looks like, and ten `read_file`
calls in a row, which is what reading a codebase looks like.

An agent that loops with slightly varied arguments still slips through. Catching that needs
semantic similarity, at the price of a model call per check.

## Control the run

Defaults are 100 iterations, and no cost, token, or duration cap. Set them globally in
`~/.jazz/config.json`, per workflow in frontmatter, or per run on the command line. See
[Budgets](../concepts/budgets.md).

For exact thresholds and the code that enforces them, read the
[context lifecycle](../maintainers/context-lifecycle.md) and
[run lifecycle](../maintainers/run-lifecycle.md).
