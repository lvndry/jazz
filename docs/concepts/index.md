---
description: "Understand the core Jazz concepts: agents, personas, tools, skills, workflows, conversations, memory, surfaces, subagents, webhooks, peers, and the daemon."
---

# Jazz concepts

Jazz combines a small set of independent building blocks:

- An [agent](./agents.md) selects a model, persona, capabilities, and restrictions.
- A [persona](./personas.md) supplies reusable behavioral instructions.
- A [tool](./tools.md) lets the model inspect or change something.
- A [skill](./skills.md) teaches the model how to complete a kind of work.
- A [workflow](./workflows.md) packages a prompt with repeatable run settings.
- A [conversation](./conversations-and-memory.md) carries dialogue; working state and memory provide different kinds of continuity.
- A **surface** is where a person or system reaches the agent: terminal, headless command, schedule, bot, webhook, or peer request.
- A [subagent](./peers-and-subagents.md) is a delegated child run on the same installation.
- A [webhook](./webhooks.md) is a fixed, authenticated HTTP door onto an agent.
- A [peer](./agent-to-agent.md) is another explicitly trusted Jazz agent.
- The [daemon](./daemon.md) is the process that serves runs, webhooks, and peer requests over HTTP when no terminal is attached.

The boundaries matter. A skill is not a tool, a workflow is not an agent, and a webhook is not a peer. Keeping those roles separate lets the same agent move between surfaces without duplicating its identity or policy.
