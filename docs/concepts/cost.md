---
description: "How Jazz accounts for what a run cost, and why it reports the figure as unknown rather than printing a confident zero."
---

# Cost, and admitting when it is unknown

Every run reports what it spent. The interesting part is what happens when Jazz cannot work that
out, because the tempting answer is `$0.00` and that answer is a lie.

## The rule

A cost is **known** when the provider priced the call, or when the model genuinely costs
nothing, which means a local Ollama or llama.cpp model serving from your own machine. Anything
else is **unknown**, and Jazz says so rather than guessing.

```json
{ "ok": true, "answer": "…", "costUSD": 0, "costKnown": false }
```

`costUSD` stays `0` in that envelope for compatibility with consumers that read it blindly. It is
`costKnown` that tells you whether the zero means anything. A consumer enforcing a spend ceiling
must check it; the figure is otherwise a floor, not a total.

An Ollama model with a cloud tag is the edge that proves the rule: the provider name says local,
the billing happens remotely, so it does not count as free.

## Children roll up

A run's cost includes everything it delegated (subagents, media companions, summarization) not
just its own model calls. `/cost` in the terminal shows the session total including children.

The honesty rule survives the rollup, which is the part that takes effort. If any child's price
is unknown, the parent marks its own total incomplete instead of reporting the sum of the parts
it happened to know. A parent that quietly added up two of three children would be more
misleading than one that admits it cannot say.

## Budgets

Caps are set per workflow or per run, and checked between iterations rather than mid-call:

| Cap              | Stops the run when                                  |
| ---------------- | --------------------------------------------------- |
| `maxCostUSD`     | spend passes the ceiling                            |
| `maxTokens`      | cumulative prompt + completion tokens pass it       |
| `maxDurationMs`  | wall-clock time passes it                           |
| `maxIterations`  | the loop has taken that many turns: default 100    |

The first three are unset by default, which means uncapped. All four warn the agent as they fill
rather than only cutting it off, so it can consolidate what it has instead of being killed
mid-thought. Cost, tokens and duration nudge at 50, 80 and 90% of the budget; iterations nudge at
70 and 90%.

A cost cap cannot be enforced against an unpriced model. That is another reason unknown is
reported as unknown.

## Related

- [Long-running work](../features/long-running-work.md): budget pressure and compaction
- [Workflow frontmatter](../configure/workflows.md): where the caps are set
- [Headless](../surfaces/headless.md): the JSON envelope in full
