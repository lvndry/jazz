---
description: "Cap a Jazz run by iterations, cost, tokens, or wall-clock time, watch what it is spending with /cost and /limit, and know when a cap can be crossed."
---

# Budgets: capping and watching a run

Four caps bound a run, and every one of them is optional except the first.

| Cap             | Default | Counts                                                           |
| --------------- | ------: | ---------------------------------------------------------------- |
| `maxIterations` |   `100` | Reason-and-act cycles in a top-level run                         |
| `maxCostUSD`    |   unset | Model spend in dollars, **own run plus everything it delegated** |
| `maxTokens`     |   unset | Prompt plus completion tokens, **own run only, not children**    |
| `maxDurationMs` |   unset | Wall-clock time                                                  |

That asymmetry on the middle two is deliberate and worth remembering. A cost cap is what you
want when an agent delegates, because children are where the money goes. A token cap needs no
pricing data at all, which makes it the one that still works on a model nobody has priced.

Two more shape delegation itself: `maxSubagentIterations` (30) and `maxSubagentDepth` (3), where
`0` disables delegation outright.

## Where to set them

Three places, narrowest wins:

```jsonc
// ~/.jazz/config.json: every run on this machine
{ "maxIterations": 60, "maxCostUSD": 2.0 }
```

```yaml
# a workflow's frontmatter: this workflow, every time it runs
maxIterations: 40
maxCostUSD: 1.00
maxDurationMs: 900000
```

```bash
# one run
jazz run --agent analyst --max-cost-usd 0.50 --max-duration-ms 300000 "…"
```

## Watching from the terminal

```text
/cost     tokens and USD for this conversation, sub-agents included
/limit    set a turn, cost, or token cap on this session, applied immediately
```

`/limit usd 5` caps the session at five dollars and tells you straight away if you are already
past it. `/limit clear` removes it. The cap gates the next turn rather than killing the current
one, so you get asked to confirm rather than losing work in flight.

## Watching from a script

```json
{
  "ok": true,
  "answer": "…",
  "costUSD": 0.0041,
  "costKnown": true,
  "tokenUsage": { "promptTokens": 1204, "completionTokens": 6, "totalTokens": 1210 }
}
```

A failed envelope still carries `costUSD`, because a run that timed out still spent money and an
unattended deployment has to account for it. `jazz workflow history <name>` shows the same
figures per scheduled run.

## Caps are checked between iterations

None of these is a preemptive interrupt. Jazz checks them at the boundary between iterations, so
a single model call or tool phase can cross a cap before the next iteration is stopped. Budget
`--max-cost-usd` with that in mind, and use `--timeout` when you need a hard deadline around the
whole run rather than a soft checkpoint inside it.

The agent is warned as a budget fills rather than only being cut off. Cost, token and duration
budgets nudge it at 50, 80 and 90%; iterations nudge at 70 and 90%. The messages are ephemeral,
so a run that survives its own warnings does not carry eight escalating reminders into the next
summarization.

## When the figure is unknown

A cost is known when the provider priced the call, or when the model genuinely costs nothing,
which means a local Ollama or llama.cpp model. Anything else is unknown, and Jazz says so:

```json
{ "ok": true, "costUSD": 0, "costKnown": false }
```

`costUSD` stays `0` there for compatibility with consumers that read it blindly, so anything
enforcing a ceiling has to check `costKnown` rather than the number. If any delegated child's
price is unknown, the parent marks its own total incomplete instead of reporting the sum of the
parts it happened to know. An Ollama model with a cloud tag is the edge that proves the rule:
local provider name, remote billing, so it does not count as free.

A cost cap cannot be enforced against a model nobody has priced. That is the case `maxTokens`
exists for.

## Related

- [Long-running work](../features/long-running-work.md): what happens as the context fills
- [Workflow frontmatter](../configure/workflows.md): the caps as workflow fields
- [Configuration](../configure/jazz.md#run-budgets): the defaults and the enforcement model
- [Headless](../surfaces/headless.md): the full JSON envelope
