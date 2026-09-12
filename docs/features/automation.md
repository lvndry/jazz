---
description: "Run Jazz agents from scripts, CI, scheduled workflows, reminders, webhooks, and background jobs with explicit budgets and approval policies."
---

# Automate AI agent work with Jazz

Jazz supports several automation shapes. Choose based on who starts the work and whether a person can answer during the run.

- **One-shot command:** `jazz run` starts now and returns an answer or JSON envelope.
- **Workflow:** a versioned `WORKFLOW.md` combines a prompt with run and schedule metadata.
- **Schedule:** launchd, cron, or the daemon ticker starts a workflow later.
- **Reminder:** an agent schedules a future notification for its user.
- **Wake trigger:** an agent asks Jazz to resume work at a future instant or when a command condition becomes true.
- **Webhook:** another system sends an authenticated event to a fixed agent and prompt template.

Unattended runs cannot answer interactive questions. They must decline gated actions, receive an explicit auto-approval policy, or use `--park` so a person can approve and resume the saved run later.

Start with [Scheduled runs](../surfaces/scheduled.md), [Headless runs](../surfaces/headless.md), or [Webhooks](../concepts/webhooks.md).
