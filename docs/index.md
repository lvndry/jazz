---
description: "Install Jazz, run an AI agent from the terminal or unattended, connect tools and chat surfaces, and understand how the open-source agent harness works."
---

# Jazz documentation

Jazz is an open-source AI assistant that can read and edit files, run commands, research the web, and create documents and visuals. You choose its model and permissions, then use it in your terminal, scripts, CI, schedules, or chat apps.

## Start in two minutes

```bash
curl -fsSL https://github.com/lvndry/jazz/releases/latest/download/install.sh | bash
jazz
```

On first run, choose **Start setup** to pick a model provider and create your agent. You can then ask it to inspect files, work with git, read the web, or create artifacts. See the [quick start](./getting-started/quick-start.md) for the complete first session.

## Choose what you need

- **New to Jazz:** [install it and complete your first useful run](./getting-started/index.md).
- **Evaluating Jazz:** [explore its capabilities](./concepts/index.md) and [compare where it runs](./surfaces/index.md).
- **Creating an agent:** [configure its model, persona, and tools](./getting-started/create-an-agent.md).
- **Setting up a job:** follow a [guide](./guides/index.md).
- **Operating it safely:** read the [security model](./security/index.md), and [what Jazz sends over the network on its own](./security/privacy.md).
- **Finding what Jazz keeps on disk:** the [runtime data](./runtime-data/index.md) reference lists every file and directory it writes.
- **Fixing something that went wrong:** start with [troubleshooting](./troubleshooting.md). [Uninstalling](./getting-started/uninstall.md) removes everything Jazz put on the machine.

## What you can do

- **Work on a project:** ask an agent to explore a repository, make a change, and run the checks. [Agents](./concepts/agents.md) and [project instructions](./concepts/agents.md#project-instructions-agentsmd) let you tailor it to your work.
- **Finish a larger task:** give Jazz a [goal](./concepts/goals-and-loops.md) and a way to verify completion. It continues across turns; [context management](./concepts/context-management.md) makes room as the conversation grows.
- **Watch for changes:** use a [loop](./concepts/goals-and-loops.md#loops) to check a deployment, or schedule a [workflow](./concepts/workflows.md) for a recurring briefing or review.
- **Create something you can use:** ask for a PDF, generated media, or an interactive [composition](./concepts/compositions.md) such as a dashboard or calculator. Results are saved as [artifacts](./concepts/artifacts.md).
- **Use several models together:** keep your preferred main model and add [companions](./concepts/media.md) for images, audio, or video. Delegate independent research or checks to [subagents](./concepts/agents.md#delegation).
- **Connect your tools:** add [MCP servers](./configure/mcp.md), [custom tools](./configure/agents.md#custom-tools), and [skills](./concepts/skills.md) for your own systems and procedures.
- **Reach Jazz wherever you work:** use the same agent in [scripts and CI](./surfaces/headless.md), [chat apps](./surfaces/chat.md), or behind a [webhook](./concepts/webhooks.md). Use [/detach](./concepts/detach.md) to continue a conversation on your server.

Choose cloud or [local models](./getting-started/local-models.md), set [budgets](./concepts/budgets.md), and control actions through [approvals](./security/approvals.md).

## Exact syntax

The [CLI reference](./commands.md) lists `jazz` commands, subcommands, global options, and flags. For the terminal experience, read [CLI](./surfaces/cli.md). Before updating across a minor version, read [Upgrading](./upgrading.md) for the versioning policy and how breaking changes are announced. Configuration and tool details live under [Configure](./configure/index.md) and [Tools](./tools/index.md).
