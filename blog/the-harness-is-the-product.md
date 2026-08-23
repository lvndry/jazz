---
title: "The harness is the product"
description: "What an agent harness actually is, why the loop is the easy part, and a tour of the guards that keep a Jazz run alive for eighty iterations unattended."
date: 2026-08-23
---

Every AI agent is two things: a model, and a harness. The model you rent —
everyone rents from the same three or four companies, and whatever model you
use today, your competitor can use tomorrow. The harness is everything wrapped
around it: the loop that feeds it, the context it sees, the tools it's allowed
to touch, the guards that catch it when it spirals. The model is the musician.
The harness is the venue, the mixing desk, the set list, and the person who
cuts the power when the amp catches fire.

Here's the thing nobody tells you: the loop at the center of every agent is
about twenty lines. Ask the model, run the tools it asked for, feed the
results back, repeat until it answers. You can write it in an afternoon, and
most agents are exactly that afternoon project with a nicer README.

The difference between a demo and something you can leave running unattended
is everything *around* those twenty lines. That's the harness, and in Jazz
it's the part we treat as the actual product. A tour of the guards, with the
real numbers.

## The agent has a sense of its own budget

A Jazz run is bounded at 80 iterations. An agent with 80 iterations and no
sense of time will happily spend all 80 on research and produce nothing —
so past 70% of the budget the harness tells it to consolidate, and past 90%
to write its final output with what it has.

The interesting detail is what *doesn't* happen: the pressure message is
ephemeral. It's appended to the array sent to the model for that one call
and never stored in the conversation:

```ts
const budgetMsg = buildBudgetPressureMessage(iterationIndex + 1, maxIterations);
const messagesForLLM = budgetMsg ? [...state.currentMessages, budgetMsg] : state.currentMessages;
```

If it were stored, iteration 78 would carry eight escalating "FINISH NOW"
messages, each costing tokens and confusing the transcript that later gets
summarized. The nudge steers the run without polluting its history.

## Meltdown detection — the groove detector

The classic agent failure isn't a crash. It's a groove: the same search, the
same file read, forever, until the budget is gone. Jazz keeps a rolling
window of the last 10 tool calls and measures how repetitive they are:

```ts
const keys = window.map((tc) => `${tc.name}:${tc.arguments}`);
const uniqueness = new Set(keys).size / windowSize;
return uniqueness < 0.4;
```

The key is composite — tool name *plus* arguments — and that distinction is
the whole design. Ten `web_search` calls with ten different queries is 100%
unique: that's research, leave it alone. Ten `web_search` calls with the
same query is 10% unique: that's a groove. Keying on the tool name alone
would flag reading ten different files as a meltdown, which is exactly the
behavior you want from an agent reading a codebase.

When the detector trips, the harness injects a message telling the agent to
stop, summarize what it has, and try a fundamentally different approach —
and unlike budget pressure, this one *is* stored, because "your last
approach didn't work" is something the run should keep remembering.

## Context is managed like the scarce resource it is

Three mechanisms, three jobs, deliberately layered
([the full writeup](/docs/internals/context-management)):

1. **Counting.** Every provider tokenizes differently, so Jazz estimates
   before each call and calibrates against what the provider actually
   reports after it. You can't decide when to act without knowing how full
   you are.
2. **Compaction at 80%** of the window: one LLM call summarizes the middle
   of the conversation, keeping the system message and recent turns intact.
   Lossy, but coherent — the gist survives.
3. **Trimming at 95%**, the emergency brake: drop the oldest messages, no
   LLM call. It's turn-aware — it never splits a tool call from its result,
   because a history where a `tool_calls` entry has no matching result is
   invalid at most providers.

The ordering is the hard-won part. An earlier version trimmed at a flat
50k tokens regardless of the model, which meant on any large window the
summarizer never ran — the run silently degraded into a sliding window, and
because trimming rewrites the start of the message list, it also invalidated
the provider's cacheable prefix on every single turn. Compaction now gets
first refusal; trimming only fires when summarizing couldn't help. When
messages do get discarded unsummarized, you're told.

And because a summary is still lossy, working state — the todo list, key
findings — lives *outside* the message history and survives compaction
untouched.

## Tools run in two phases, and the ask travels

A gated tool doesn't act when the model calls it. The propose phase does
real work — resolves the path, reads the current file, computes the exact
diff — and mutates nothing. What comes back is a description of what
*would* happen, and that's what you approve.

Why a pair of phases instead of a `dangerous: true` flag? Because you can't
show a useful preview without doing the work. Two phases is what makes
"here is the exact diff, approve?" possible instead of "the model wants to
write a file, trust it?".

Every tool declares a risk tier — read-only, low-risk, high-risk — and one
dial decides what runs without asking. `execute_command` is declared
*unknown*, because the command decides the blast radius: a cheap harness
model classifies each specific command, so `--approval-policy read-only`
runs `git log` unattended without also unlocking `rm`.

The part that matters for an everyday agent: interactive and unattended runs
go down the *same* path. The only difference is who answers the gate — you
at the terminal, you on Telegram, or a policy you set in advance. There is
no separate headless mode to drift out of sync with the interactive one.
This isn't paranoia for its own sake: a coding agent asks to edit a file
you can revert. An everyday agent asks to send an email. There is no undo.

## The receipts are part of the harness

Every run ends with a cost figure, and the figure is honest: a run whose own
tokens are unpriced (a local model) but which spawned a priced sub-agent
still reports the sub-agent's spend — otherwise the number would silently
understate what you paid. Metrics are written on a forked fiber that the
loop awaits on release: you get your answer immediately, and the telemetry
still lands even if the process is shutting down.

And when something *is* wrong, it fails loudly at the source. If a requested
tool call comes back without a result, the run hard-fails rather than
pasting in a placeholder — because the placeholder version produces a
provider error three iterations later, somewhere unrelated, and the bug
becomes unfindable.

## Why this is the moat

None of these guards is glamorous. Each one exists because a real run failed
without it: the groove, the sliding-window regression, the cache-prefix
invalidation, the phantom tool result. A harness is a collection of scars,
and scars only accumulate in code that actually runs unattended, on real
accounts, where a failure costs something.

That's what's special about the Jazz harness — not any single trick, but
that the whole thing is built for the run nobody is watching. The model will
keep getting smarter, and every agent gets that upgrade for free. The
harness is the part you choose.

All of it is MIT-licensed and documented at the level of this post and
below: start at [the agent loop](/docs/internals/agent-loop), then
[context management](/docs/internals/context-management) and
[tools & approval](/docs/internals/tools-and-approval). If you'd rather
just see it play, the [homepage](/) runs a session in front of you.
