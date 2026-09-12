---
description: "Run Jazz safely in scripts, CI, schedules, webhooks, and chat bridges by controlling tools, approvals, budgets, identity, credentials, and isolation."
---

# Secure unattended Jazz agents

An unattended agent has nobody at the terminal to correct a misunderstanding. Configure the boundary before increasing autonomy.

1. Give the agent only the tools required for the job and explicitly deny capabilities it must never receive.
2. Set iteration, token, cost, duration, and external timeout limits appropriate to the task.
3. Use the lowest approval policy that permits the expected actions.
4. Scope credentials and filesystem access outside Jazz with a dedicated operating-system user, container, or CI environment.
5. Give every external conversation a stable, collision-resistant identity.
6. Authenticate remote surfaces and keep allowlists narrow.
7. Test the run in the foreground before scheduling or exposing it.

If a job may require approval later, use the daemon and `--park`. Otherwise Jazz should decline the gated action instead of waiting for input that cannot arrive.
