---
description: "How Jazz keeps a long agent run useful: budget pressure, compaction at 80%, turn-aware trimming, work state, tool-result offloading, and meltdown detection."
---

# Long-running work

Long work fails in three ways. The agent loses the task, it repeats itself, or it hits a hard
limit with nothing to show. Jazz treats all three as harness problems rather than prompting
problems, because a model cannot fix them from inside the conversation it is losing.

## The ladder, in order of when it fires

| At                                             | What happens                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| 50/80/90% of a cost, token, or duration budget | The model is told, and asked to consolidate                        |
| 70/90% of the iteration budget                 | Same, on the iteration axis                                        |
| 70% of the context window                      | The model is warned that older history will be summarized          |
| 80% of the context window                      | Compaction: the middle is summarized, system and recent turns kept |
| 95% of the context window                      | Trimming: whole turns dropped, never mid-tool-call                 |

Every warning is ephemeral. It is added to that one request and never stored, because a history
carrying eight escalating FINISH NOW messages wastes tokens, contradicts itself, and poisons the
very summarization it was warning about.

## Compaction keeps the beginning

A sliding window is the obvious design and the wrong one: it drops the oldest messages, which is
where the task definition and the plan live. Forty minutes in you would keep a tool result about
page 14 of a PDF and lose the reason you were reading it.

So compaction summarizes the middle and rebuilds as `[system, summary, recent turns]`. It costs
an extra model call and loses real detail, which is why it is visible rather than silent, why
`summarizerModel` lets you point it at something cheap, and why the agent can trigger it
deliberately with `summarize_context` when it knows it is about to need room.

Trimming below that is coarser and protects one invariant absolutely: an assistant message's
`tool_calls` and its `tool` results move together. Splitting them is invalid to most providers,
and the resulting 400 arrives several iterations later, far from the cause.

## What survives compaction

Detail is lost when history is summarized. Three things are designed to outlive it:

- **[Work state](../concepts/conversations-and-memory.md)** holds the objective, decisions, open
  questions, and next step. History records what was said; work state records intent, which is
  the half only the agent knows.
- **Todos** hold the list of work and its verification status.
- **Offloaded tool results** are written to the conversation's work directory and replaced in
  context by a pointer the model can call `retrieve_tool_result` on. This happens every
  iteration rather than at a window-fill threshold, because a 200k model was otherwise carrying
  130k of already-read file output on every round trip.

The practical rule: a conclusion worth keeping goes into work state, a todo, or a file. A
conclusion sitting only inside a large tool result is a conclusion you are trusting compaction
with.

## Meltdown detection

Over the last 10 tool calls, if unique `name:arguments` keys fall below 40%, the agent is told it
is looping and the window resets.

It keys on name _and_ arguments deliberately. Counting repeats of the tool name alone would flag
`web_search → web_fetch → web_search` as a meltdown, which is what research looks like, and ten
`read_file` calls in a row, which is what understanding a codebase looks like. An agent that
loops with slightly varied arguments still slips through; catching that needs semantic
similarity, which costs a model call per check.

## Control the run

Defaults are 100 iterations, and no cost, token, or duration cap. Set them globally in
`~/.jazz/config.json`, per workflow in frontmatter, or per run on the command line. See
[Budgets](../concepts/budgets.md).

For exact thresholds and the code that enforces them, read the
[context lifecycle](../maintainers/context-lifecycle.md) and
[run lifecycle](../maintainers/run-lifecycle.md).
