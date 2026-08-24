---
title: "The harness is the product"
description: "What an agent harness actually is — from the first tool call to the guards that keep a run alive for a hundred iterations unattended. A tour of the Jazz harness, with the real numbers."
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
it's the part we treat as the actual product. This post is the tour — starting
from the obvious parts, because the obvious parts are where the design
decisions hide.

## Start with the hands: tools

A language model can only emit text. A *tool call* is the one trick that
turns text into action: the model emits a small JSON object — a name and
arguments, `read_file({"path": "notes.md"})` — the harness executes the real
function behind that name, and the result goes back into the conversation as
a message. That's it. Everything an agent "does" in the world passes through
this needle.

So the first thing a harness is, is a **registry**: the catalog of names the
model is allowed to emit. Jazz ships 35 agent-facing tools, and most of them
are exactly the ones you'd expect — `read_file`, `edit_file`, `grep`,
`web_search`, `web_fetch`, `http_request`, `execute_command`. Their being
expected is the point. An agent is useful in proportion to how boring its
hands are: files, shell, web. The novelty is not the catalog; it's the
bookkeeping around it.

Three pieces of bookkeeping, specifically:

- **Every tool declares a risk tier** — 20 are read-only, 7 low-risk, 6
  high-risk, and one (`execute_command`) is *unknown*, because the command
  decides its own blast radius. More on what the tiers buy below.
- **Seven tools are approval pairs.** Calling `write_file` doesn't write a
  file — it returns a description of what *would* happen, and a hidden
  `execute_write_file` counterpart does the writing only after the gate says
  yes. The model can't even see the `execute_*` names.
- **The reference page for all of this is enforced by a test** that fails if
  the registry and the docs drift apart. Harness discipline extends to the
  documentation, or the documentation is fiction within a month.

Beyond the built-ins, the registry is open on three sides: MCP servers add
`mcp_<server>_<tool>` entries discovered from the agent's config, skills add
their three loader tools, and agent configs can define custom tools. Same
registry, same tiers, same gates.

## Skills: tools are *what*, skills are *how*

Give an agent `web_search` and `write_file` and ask it to "deep-research this
topic properly," and it will wing it — differently every time. A **skill** is
a packaged playbook: a folder with a `SKILL.md` of instructions, optional
reference docs, optional scripts. Tools are what the agent uses; skills are
how it should use them.

The interesting harness problem is cost. A serious skill library is tens of
thousands of tokens of instructions, and stuffing them all into every
conversation would burn the context window before the user says a word. Jazz
loads skills by **progressive disclosure**, in three levels:

1. **Always present:** an index of skill names with one-line descriptions —
   a few hundred tokens total, enough for the agent to know a playbook
   exists.
2. **On demand:** when a request matches, the agent calls `load_skill` and
   gets the full `SKILL.md` — the workflow, the output format, the examples.
3. **Deeper on demand:** heavy skills point at reference files, and
   `load_skill_section` pulls in only the section the workflow actually
   needs.

The agent can have access to dozens of skills but pays the token cost only
for the ones it uses, at the depth it uses them. This is the same principle
you'll see again in context management below: **the context window is the
scarce resource, and everything in the harness is designed around not
wasting it.**

## Sub-agents: isolation, not speed

The third structural piece. When a task involves reading a lot — deep
research across twelve sources, say — the reading costs 100,000 tokens. Do
that in the main conversation and the parent is compacting by iteration
fifteen and has forgotten what it was doing.

So the agent can delegate: `spawn_subagent(task)` starts a child run with
**its own context window**. The child burns its 100k tokens, returns one
paragraph, and its context is discarded. The parent pays a paragraph for
twelve sources. People assume sub-agents are about parallelism; in Jazz
they're primarily about *quarantining token spend*. (And the child's cost is
added to the parent's bill — more on receipts later.)

With the structure in place — tools as hands, skills as playbooks,
sub-agents as quarantine — we can get to the part that earns the title: the
guards. Each one exists because a real unattended run failed without it.

## Guard: the agent has a sense of its own budget

A Jazz run is bounded at 100 iterations. An agent with 100 iterations and no
sense of time will happily spend all 100 on research and produce nothing —
so past 70% of the budget the harness tells it to consolidate, and past 90%
to write its final output with what it has.

The interesting detail is what *doesn't* happen: the pressure message is
ephemeral. It's appended to the array sent to the model for that one call
and never stored in the conversation:

```ts
const budgetMsg = buildBudgetPressureMessage(iterationIndex + 1, maxIterations);
const messagesForLLM = budgetMsg ? [...state.currentMessages, budgetMsg] : state.currentMessages;
```

If it were stored, iteration 98 would carry ten escalating "FINISH NOW"
messages, each costing tokens and confusing the transcript that later gets
summarized. The nudge steers the run without polluting its history.

## Guard: meltdown detection

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

## Guard: context is managed like the scarce resource it is

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

## Guard: the gate, and who answers it

Back to those approval pairs. Why two phases instead of a `dangerous: true`
flag? Because you can't show a useful preview without doing the work. The
propose phase resolves the path, reads the current file, computes the exact
diff — and mutates nothing. That's what makes "here is the exact diff,
approve?" possible instead of "the model wants to write a file, trust it?".

The risk tiers turn this into one dial: `--approval-policy read-only` means
anything read-only runs unattended and everything else waits for a human.
For `execute_command`, whose declared tier is *unknown*, a cheap harness
model classifies each specific command first — so `git log` runs unattended
under a read-only policy without also unlocking `rm`.

The part that matters most for an everyday agent: interactive and unattended
runs go down the *same* path. The only difference is who answers the gate —
you at the terminal, you on Telegram, or a policy you set in advance. There
is no separate headless mode to drift out of sync with the interactive one.
And this isn't paranoia for its own sake: a coding agent asks to edit a file
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

None of this is glamorous. The registry, the loader levels, the composite
meltdown key, the compact-before-trim ordering — each exists because a real
run failed without it: the groove, the sliding-window regression, the
cache-prefix invalidation, the phantom tool result. A harness is a
collection of scars, and scars only accumulate in code that actually runs
unattended, on real accounts, where a failure costs something.

That's what's special about the Jazz harness — not any single trick, but
that the whole stack, from the obvious tools up through the guards, is built
for the run nobody is watching. The model will keep getting smarter, and
every agent gets that upgrade for free. The harness is the part you choose.

All of it is MIT-licensed and documented at the level of this post and
below: start at [the agent loop](/docs/internals/agent-loop), then
[context management](/docs/internals/context-management),
[tools & approval](/docs/internals/tools-and-approval),
[skills loading](/docs/internals/skills-loading), and
[sub-agents](/docs/internals/subagents). If you'd rather just see it play,
the [homepage](/) runs a session in front of you.
