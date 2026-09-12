---
description: "What to decide before a Jazz agent runs with nobody watching: toolset, approval policy, budgets, identity, credentials, and where it actually runs."
---

# Unattended runs

An unattended agent has nobody at the terminal to catch a misunderstanding. Every control below
exists because the usual recovery, a person saying "no, not like that", is unavailable.

Work through them before increasing autonomy, roughly in this order.

## 1. Cut the toolset first

This is the strongest control and the one people skip. An agent that cannot call
`execute_command` cannot run a shell command, whatever the approval policy says, whatever the
prompt says, and whatever a malicious payload talks it into.

Use `deniedTools` rather than omission: `tools` is additive and leaving something out withholds
nothing. A CI reviewer should hold reads, greps, and nothing that writes.

## 2. Pick the lowest policy that does the job

`read-only` for anything that only inspects. `low-risk` for jobs that maintain todos or delegate.
`high-risk` only where the job's whole purpose is to change something, and then only with the
toolset already cut to that one thing.

Reaching for a higher policy to admit a single command is the wrong move. Use
`autoApprovedCommands` for that one binary, and see [approvals](./approvals.md).

## 3. Bound the blast radius in time and money

Set `maxCostUSD`, `maxTokens`, `maxDurationMs`, and a sensible `maxIterations`. An unattended run
with no cost cap is a run whose worst case is your credit limit. Remember that caps are checked
between iterations, so pick numbers with headroom, and use an external `--timeout` when you need
a hard wall. See [budgets](../concepts/budgets.md).

## 4. Decide what happens at a gate

Default behaviour is to decline gated calls and report them, which is usually right: the run
finishes and tells you what it could not do.

`--park` is for the other case, where the job is pointless without the decision. It saves the
run, exits `2`, and waits for `jazz runs approve`. Park only where somebody will actually look,
because a parked run nobody answers is a job that silently did not happen.

## 5. Give every external conversation a stable identity

A bridge or webhook that reuses one conversation key across senders mixes people's history
together. Derive the key from the platform's own id, and make sure it cannot collide.

## 6. Put it somewhere with less to lose

Jazz's controls bound what the model chooses to do. The operating system bounds what is reachable
when that fails, and only the second one holds if a prompt injection succeeds.

Run unattended agents as a dedicated OS user, or in a container, with credentials scoped to that
job and nothing else. The Telegram bridge does this per chat, giving each one its own Unix user
and Jazz home, so one person's agent cannot read another's mail credentials.

## 7. Run it in the foreground first, under the real policy

```bash
jazz workflow run my-job --auto-approve
```

Same code path the scheduler uses. A job tested interactively, where you approved things by hand
without noticing, is a job that will behave differently at 6am.

## Related

- [Approvals](./approvals.md): what runs without asking
- [Surface access](./surface-access.md): authenticating the way in
- [Scheduled runs](../surfaces/scheduled.md) · [Headless](../surfaces/headless.md) ·
  [Webhooks](../concepts/webhooks.md)
- [Threat model](./threat-model.md): what none of this stops
