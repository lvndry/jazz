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

Use a cost cap to bound delegation spend. Token caps work without pricing data.

Two more shape delegation itself: `maxSubagentIterations` (30) and `maxSubagentDepth` (3), where
`0` disables delegation outright.

## What the cost includes

`costUSD`, and the `maxCostUSD` cap, count every model call the run paid for:

- its own turns, with prompt-cache reads at the cache-read rate and cache writes at the
  cache-write rate;
- every sub-agent it spawned, including one that failed or was stopped;
- the calls it makes for itself: compaction summaries, memory extraction before compaction,
  and the command-risk classifier.

A sub-agent runs under what its parent has left: the remaining time, the remaining
`maxCostUSD` (while the parent's spend is fully priced) and the remaining `maxTokens`. Once
any of them is used up, the parent is told to finish with what it has instead of delegating.
Sub-agents running at the same time share that remainder: each reports its spend after every
step, and both the parent's and every child's cost check count what the others have spent so far,
so together they stop at the parent's `maxCostUSD`. `maxTokens` is still counted per run: each
child gets the parent's remaining tokens.

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

A failed envelope still carries `costUSD`, `costKnown` and `tokenUsage`. A run
killed from outside leaves no envelope; `--events spend` streams `run_spend` events with the
running total so the caller can use the last one. The chat bridges do exactly that: their daily
spend cap counts failed, timed-out and cancelled runs, not only answered ones.
`jazz workflow history <name>` shows the same figures per scheduled run, failed runs included.

## When a cap stops the run

`maxIterations`, `maxCostUSD` and `maxTokens` are checked between iterations, so one model call
or tool phase can cross them before the next iteration stops. Budget `--max-cost-usd` with that
in mind.

`maxDurationMs` is a deadline. When it passes, Jazz interrupts whatever is running: the model
call is aborted, a shell command is killed with every process it started, and a sub-agent stops
with it. Unfinished tool calls are closed with a note, and the run returns what it had with
`durationCapped: true`. A sub-agent is given only the time its parent has left, so delegating
work never extends the deadline.

`--timeout` is a harder wall around the whole run, including start-up. It ends the run as a
failure, with the same cleanup: running commands are killed and the provider request is aborted.

The agent is warned as a budget fills rather than only being cut off. Cost, token and duration
budgets nudge it at 50, 80 and 90%; iterations nudge at 70 and 90%. The messages are ephemeral,
so a run that survives its own warnings does not carry eight escalating reminders into the next
summarization.

## When the figure is unknown

A cost is known when the provider priced the call, or when the model genuinely costs nothing,
which means a self-hosted Ollama, llama.cpp, vLLM, or SGLang model. Anything else is unknown, and Jazz says so:

```json
{ "ok": true, "costUSD": 0, "costKnown": false }
```

`costUSD` stays `0` for compatibility with consumers that read it blindly. Check `costKnown`, not
the number.

One unknown child makes the parent's total unknown too.

The same goes for cache writes: when the pricing data has no cache-write rate for the model,
they are priced at the plain input rate and the total is marked unknown, since providers such as
Anthropic charge more for them.

An Ollama model with a cloud tag uses remote billing and does not count as free.

A cost cap cannot be enforced against a model nobody has priced. That is the case `maxTokens`
exists for.

## Daily and monthly caps

The caps above bound one run. A goal that runs every ten minutes, or a workflow that fails and
retries, stays under every per-run cap while the bill grows. The `daemon` spend caps bound the
total: every run's final cost, failed and cancelled runs included, is recorded in one ledger
under `$JAZZ_HOME/spend`, and the caps count what **unattended** runs (nobody could be asked
while they ran) spent per local day and month. Your chat turns never count.

```jsonc
{
  "daemon": {
    "dailyCostUSD": 5,
    "dailyTokens": 2000000,
    "monthlyCostUSD": 60,
    "goals": { "dailyCostUSD": 2, "monthlyCostUSD": 20 },
    "agents": { "inbox": { "dailyCostUSD": 1 } },
  },
}
```

Every cap is unset, meaning unlimited, until you set one. `goals` covers goal cycles and loop
runs together; `agents.<agent>` covers one agent's unattended runs, keyed by its name (`inbox`
above) or its id, as `jazz agent list` shows them. `jazz config set` and `jazz spend` warn about
a key that names no agent. Set the goal caps and the machine-wide ones from `jazz` > Update
configuration > Spend Limits, or with `jazz config set daemon.goals.dailyCostUSD 2`.

When a cap is reached:

- **The daemon pauses** at a machine-wide daily cap (`dailyCostUSD`, `dailyTokens`) until local
  midnight, and tells your [notify targets](../configure/notifications.md) once.
  `jazz daemon resume` lifts the machine-wide daily caps for the rest of the day, whether or not
  a daemon was running; monthly, goal and agent caps stay in force.
- **Unattended runs it covers refuse to start**: `jazz run` (with or without `--events`),
  workflows, goal cycles, loop runs, wake triggers, job batches, webhooks, peers and daemon API
  runs. The refusal names the cap and the key to change, and your notify targets hear about it
  once per cap and window. Runs still going count at the average cost of this month's
  unattended runs until they finish, so several starting at once cannot all spend the same
  headroom.
- **Goals and loops wait** instead of failing: the check runs before each cycle, and the next
  one starts on its own when the day or month turns over or you raise the cap.
- **Chat is never stopped.** It warns once when a cap covering its agent is reached. A run
  answering a parked one (`jazz runs approve`) also proceeds.

An unpriced run adds nothing to a dollar cap's spend, so the priced spend a cap counts is a
floor, and a cap it reaches is reached. A daily dollar cap with an unpriced run in its scope
today cannot be verified, so it blocks as if reached until midnight (`jazz spend` marks it
BLOCKED); a monthly one counts priced spend and shows the unpriced runs beside it. Use a priced
model, or `dailyTokens` for a model nobody has priced.

`jazz spend` shows today, this month, unattended spend, the breakdown by agent and source, and
each cap. The chat bridges record their runs in the same ledger, and `JAZZ_DAILY_COST_CAP_USD`
caps one bridge's own runs.

## Related

- [Long-running work](../features/long-running-work.md): what happens as the context fills
- [Workflow frontmatter](../configure/workflows.md): the caps as workflow fields
- [Configuration](../configure/jazz.md#run-budgets): the defaults and the enforcement model
- [Headless](../surfaces/headless.md): the full JSON envelope
- [Notifications](../configure/notifications.md): hearing about a reached cap

Chat bridges record failed and cancelled run spend in the shared machine ledger under their
own origin (for example, `telegram`), so their daily cap and `jazz spend` read the same totals.
