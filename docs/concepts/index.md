---
description: "Explore Jazz capabilities and how they work: agents, tools, skills, memory, goals, automation, model companions, peers, remote handoff, and budgets."
---

# Jazz concepts

## Agents and capabilities

- An [agent](./agents.md) selects a model, persona, capabilities, and restrictions.
- A [persona](./personas.md) supplies reusable behavioral instructions.
- A [tool](./tools.md) lets the model inspect or change something.
- A [skill](./skills.md) teaches the model how to complete a kind of work.
- [Model companions](./media.md) use specialist models to understand or generate images, audio, and video.
- [Subagents](./agents.md#delegation) delegate bounded work to child runs with isolated context.
- [MCP](../configure/mcp.md), [custom tools](../configure/agents.md#custom-tools), and [plugins](../configure/plugins.md) extend the agent's capabilities.

## Conversations and state

- A [conversation](./conversations-and-memory.md) carries dialogue; work state, todos, the scratchpad, and memory each provide a different kind of continuity.
- [Long-running work](./long-running-work.md) preserves working state, compacts history, and detects repetitive tool calls.
- An [artifact](./artifacts.md) is a file a run produced, labelled with whether a model generated it or it was rendered from data.

## Automation

- [Goals and loops](./goals-and-loops.md) keep working toward an objective or rerun a prompt until its purpose is met.
- [Automation](./automation.md) compares scripts, schedules, workflows, webhooks, wake triggers, and reminders.
- A [workflow](./workflows.md) packages a prompt with repeatable run settings.
- [Deferred work](./deferred-work.md) covers wake triggers, reminders, and background jobs that outlast a turn.

## Connections and control

- A [peer](./agent-to-agent.md) is another explicitly trusted Jazz agent.
- A [webhook](./webhooks.md) is a fixed, authenticated HTTP door onto an agent.
- [Remote handoff](./detach.md) moves a conversation to your SSH server and brings it back with its file changes.
- The [daemon](./daemon.md) is the process that serves runs, webhooks, and peer requests over HTTP when no terminal is attached.
- [Budgets](./budgets.md) cap iterations, cost, tokens, and time, including daily and monthly unattended spend.
- [Approvals](../security/approvals.md) gate actions and let unattended runs park for a human decision.

Compare [where Jazz runs](../surfaces/index.md), follow a [guide](../guides/index.md), or look up a term in the [lexicon](./lexicon.md).
