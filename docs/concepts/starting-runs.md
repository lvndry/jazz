---
description: "Choose how to start a Jazz run: a terminal command, saved workflow, schedule, loop, webhook, wake trigger, or background job."
---

# Starting runs

A run executes a prompt for an agent. You can start one yourself, call Jazz from a script,
or arrange for a schedule or external event to start it later.

## Commands and workflows

- **[Terminal chat](../surfaces/index.md#interactive):** `jazz agent chat <name>` opens a
  conversation. Each message starts a run for that agent.
- **[Headless command](../surfaces/headless.md):** `jazz run` executes one prompt from an
  argument or stdin. Use it in scripts, CI, or for a one-off task.
- **[Workflow](./workflows.md):** `jazz workflow run <name>` executes a prompt saved in
  `WORKFLOW.md`, along with its agent, permissions, and limits.

## Schedules

- **[Scheduled workflow](../surfaces/scheduled.md):** `jazz workflow schedule <name>` runs
  a workflow on its cron schedule. Use it for recurring jobs such as a daily briefing.
- **[Loop](./goals-and-loops.md#loops):** `/loop 10m <prompt>` repeats a prompt until its
  purpose is met or you stop it. Use it to check a deployment or watch for a change.

## Events and deferred work

- **[Webhook](./webhooks.md):** an authenticated HTTP request starts an agent with a fixed
  prompt template and the caller's payload. Use it for alerts and application events.
- **[Peer request](./agent-to-agent.md):** another configured Jazz agent sends a question
  to your agent, subject to the permissions you granted that peer.
- **[Wake trigger](./deferred-work.md):** the agent schedules a later run in the same
  conversation. Use it to follow up on work already in progress.
- **[Background jobs](./deferred-work.md#background-jobs-are-for-fan-out):** the agent starts
  independent shell jobs, then resumes its conversation with their results when they finish.

A [reminder](./deferred-work.md#reminders-are-for-people-triggers-are-for-agents) sends a note
without starting an agent run.

## Permissions and results

A run started without someone at the terminal uses its configured approval policy.
Actions outside that policy are declined or parked for later approval, depending on the surface.
With `jazz run`, use `--park` to save a run that needs approval. See
[Unattended runs](../security/unattended-runs.md).

Set [budgets](./budgets.md) before scheduling recurring work. Configure
[notifications](../configure/notifications.md) to receive results, failures, and approval
requests while you are away. A scheduled workflow's `deliver:` field selects where its
results are sent.
