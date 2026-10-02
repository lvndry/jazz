---
description: "Explore Jazz capabilities and how they work: agents, tools, skills, memory, goals, automation, model companions, peers, remote handoff, and budgets."
---

# Jazz concepts

Jazz can work on files, use your tools, create visuals, and keep jobs running after a turn
ends. These concepts explain how to configure that work and choose the right controls.

Start with [Agents](./agents.md). For ongoing work, read [Goals and loops](./goals-and-loops.md);
for charts and interactive pages, read [Compositions](./compositions.md).

## Agents and capabilities

- An [agent](./agents.md) selects a model, persona, capabilities, and restrictions.
- A [persona](./personas.md) supplies reusable behavioral instructions.
- A [tool](./tools.md) lets the model inspect or change something.
- A [skill](./skills.md) teaches the model how to complete a kind of work.
- [Model companions](./media.md) use specialist models to understand or generate images, audio, and video.
- The [Browser Use](./browser-use.md) tools let an agent read and act on real web pages, including ones that need JavaScript or a login.
- [Subagents](./agents.md#delegation) delegate bounded work to child runs with isolated context.
- [MCP](../configure/mcp.md), [custom tools](../configure/agents.md#custom-tools), and [plugins](../configure/plugins.md) extend the agent's capabilities.

## Conversations and state

- A [conversation](./conversations-and-memory.md) carries dialogue; work state, todos, the scratchpad, and memory each provide a different kind of continuity.
- [Why memory works this way](./memory-design.md) explains what Jazz learns about you, how scopes keep contexts apart, and why saves must quote you.
- [Context management](./context-management.md) preserves working state, compacts history, and detects repetitive tool calls.
- A [composition](./compositions.md) is a chart, dashboard, calculator, or interactive HTML page you can open or share.
- An [artifact](./artifacts.md) is a file a run produced, labelled with whether a model generated it or it was rendered from data.

## Automation

- [Goals and loops](./goals-and-loops.md) keep working toward an objective or rerun a prompt until its purpose is met.
- [Starting runs](./starting-runs.md) explains commands, workflows, schedules, and event triggers.
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
