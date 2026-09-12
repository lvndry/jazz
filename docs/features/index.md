---
description: "Explore Jazz agent features including tools, approvals, long-running work, memory, automation, media understanding, webhooks, peers, and chat surfaces."
---

# Jazz features

Jazz turns a model into an agent that can keep working, use real tools, and meet you on the surface appropriate to the job.

## Why developers choose Jazz

### Define an agent once, then run it anywhere

An agent is independent of its surface. The same model, persona, tools, memory, and restrictions work in the terminal, a script, CI, a schedule, a chat bot, a webhook, or a peer request. Moving a job does not require rebuilding the agent around a new framework.

### Treat CI and scripts as real products

`jazz run` separates the answer on stdout from progress and diagnostics on stderr. It can emit one JSON envelope, stream typed events, resume a named conversation, enforce several budgets, and return meaningful exit states. See [Headless runs](../surfaces/headless.md).

### Create several agents without duplicating behavior

Run a coding agent, researcher, inbox assistant, or reviewer with separate models and capabilities. Reuse [personas](../concepts/personas.md) across them so behavior is not welded to provider credentials or deployment code.

### Keep human control available after the terminal is gone

Jazz does not assume every approval happens synchronously. An interactive surface can ask immediately; a headless run can decline safely or park its state so somebody can approve and resume it later. See [Approvals](../security/approvals.md).

### Improve the harness, not only the model

Context pressure, compaction, durable work state, progressive tool disclosure, and verification-oriented evals are built to make smaller or weaker models more dependable. Provider switching does not remove those capabilities. See [Long-running work](./long-running-work.md) and [Testing and evals](../maintainers/testing-and-evals.md).

### Own the deployment and the data path

Jazz is open source, runs on your machine, supports local model servers, and can operate without cloud model calls. You choose the model provider, exposed surfaces, credentials, tools, storage, and network boundary. See [Local models](../getting-started/local-models.md) and [Security](../security/index.md).

## See the combinations, not only the primitives

The features become more useful together. A Jazz CI reviewer can use a model routed through OpenRouter or one served on your own runner, delegate large diffs to subagents, and return machine-checked line comments without giving the model a GitHub write token. A named persona can be reused across models and surfaces without copying its behavior into every agent.

Build the [CI pull-request reviewer](../guides/pr-review.md), [Goggins accountability agent](../guides/goggins-accountability-agent.md), [human-approved Cloudflare incident response](../guides/contain-cloudflare-attack.md), or [multi-agent verification council](../guides/multi-agent-verification.md) end to end.

## Work on a real machine

Agents can read and edit files, inspect git repositories, execute commands, fetch the web, search configured providers, create PDFs, and call MCP or custom tools. Tool availability is resolved per agent and per run. See [Tools](../concepts/tools.md) and the [tool inventory](../tools/index.md).

## Run safely with real consequences

Every tool declares risk, disclosure, and egress properties. Jazz can withhold a tool, auto-approve it, ask a person, decline it in an unattended run, or park the run until somebody responds. Start with [Security](../security/index.md).

## Survive long jobs

Jazz warns the model as iteration, time, token, cost, or context budgets fill. It compacts old history, preserves recent tool-call structure, and gives the agent working state that survives context loss. Read [Long-running work](./long-running-work.md).

## Keep continuity

A stable conversation key restores earlier messages across invocations. Durable memory is opt-in and scoped per agent. Working state records what the current job has established without pretending unfinished work is long-term memory. See [Conversations and memory](../concepts/conversations-and-memory.md).

## Automate and schedule

Run an agent once from a script, define versioned workflows, install schedules through launchd or cron, use the daemon ticker, create reminders, or register a future wake-up. See [Automation](./automation.md).

## Compose models by capability

Keep a fast or local model as the agent's orchestrator, then bind independent companions for image,
audio, and video understanding and generation. Each specialist gets only its media task while the
main agent keeps the persona, tools, memory, and conversation. Generated files return as artifacts
on the active surface. See [Model companions](./media.md) and the
[mixed-model tutorial](../guides/media-companions.md).

## Connect agents and applications

MCP adds external tool servers. Webhooks expose a fixed prompt safely. Peers let explicitly trusted Jazz agents ask each other open-ended questions. Subagents delegate bounded work with isolated context. See [MCP](../configure/mcp.md), [Webhooks](../concepts/webhooks.md), and [delegation](../concepts/agents.md#delegation) and [peers](../concepts/agent-to-agent.md).

## Run everywhere

Use Jazz in a terminal, script, CI job, schedule, Telegram, Discord, iMessage, WhatsApp, webhook, or peer network. Compare the interaction and security contracts in [Surfaces](../surfaces/index.md).
