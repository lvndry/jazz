---
description: "Run Jazz agents from scripts, CI, scheduled workflows, reminders, webhooks, and background jobs with explicit budgets and approval policies."
---

# Automate AI agent work with Jazz

Jazz supports several automation shapes. Choose based on who starts the work and whether a person can answer during the run.

| Shape | Starts it | Prompt comes from | Good for |
| ----- | --------- | ----------------- | -------- |
| **One-shot** `jazz run` | you, or a script | the argument or stdin | glue in a pipeline, CI steps |
| **Workflow** | you, or a schedule | a versioned `WORKFLOW.md` | a job worth reviewing in a pull request |
| **Schedule** | launchd, cron, or the daemon ticker | that workflow | the same job on a clock |
| **Webhook** | another system | a fixed template you wrote | reacting to someone else's event |
| **Wake trigger** | the agent itself | the agent's own prompt | resuming this conversation later |
| **Reminder** | the agent itself | nothing runs | telling a person something |

Two distinctions decide most choices. A **workflow** is a prompt you wrote and can review; a
**webhook** is a prompt you wrote reacting to a payload somebody else controls. A **wake
trigger** runs the agent again in the same conversation; a **reminder** just delivers a note and
runs nothing. See [deferred work](../concepts/deferred-work.md) for the last two.

Unattended runs cannot answer interactive questions. They must decline gated actions, receive an explicit auto-approval policy, or use `--park` so a person can approve and resume the saved run later.

Start with [Scheduled runs](../surfaces/scheduled.md), [Headless runs](../surfaces/headless.md), or [Webhooks](../concepts/webhooks.md). The last has a [step-by-step build](../guides/webhook-endpoint.md).
