---
description: "Install Jazz, run an AI agent from the terminal or unattended, connect tools and chat surfaces, and understand how the open-source agent harness works."
---

# Jazz documentation

Jazz is an open-source agent harness that lets a model work on a real machine. The same agent can run interactively in a terminal, non-interactively in scripts and CI, on a schedule, or through a chat bot you own.

## Start in two minutes

```bash
curl -fsSL https://github.com/lvndry/jazz/releases/latest/download/install.sh | bash
jazz
```

The first run opens a home menu; choose **Create agent** to pick a model provider and name your agent. You can then ask it to inspect files, work with git, read the web, or create artifacts. See the [quick start](./getting-started/quick-start.md) for the complete first session.

## Choose what you need

- **New to Jazz:** [install it and complete your first useful run](./getting-started/index.md).
- **Evaluating Jazz:** [explore its capabilities](./concepts/index.md) and [compare where it runs](./surfaces/index.md).
- **Creating an agent:** [configure its model, persona, and tools](./getting-started/create-an-agent.md).
- **Setting up a job:** follow a [guide](./guides/index.md).
- **Operating it safely:** read the [security model](./security/index.md), and [what Jazz sends over the network on its own](./security/privacy.md).
- **Finding what Jazz keeps on disk:** the [runtime data](./runtime-data/index.md) reference lists every file and directory it writes.
- **Fixing something that went wrong:** start with [troubleshooting](./troubleshooting.md). [Uninstalling](./getting-started/uninstall.md) removes everything Jazz put on the machine.

## What you can do

- **One agent, every surface:** define an agent once and use it from the terminal, CI, schedules, bots, webhooks, or another agent.
- **Built for automation:** `jazz run` keeps stdout clean, streams structured events to stderr, returns explicit exit codes, and supports JSON envelopes and run budgets.
- **More than one generic assistant:** create multiple agents with different models, personas, tools, memory scopes, and safety ceilings.
- **Several models inside one identity:** bind separate companions for image, audio, and video understanding or generation while the primary model keeps the plan, tools, memory, and conversation.
- **Approvals that survive unattended work:** decline safely, ask on an interactive surface, or park a run and resume it after remote approval.
- **Provider choice without losing the harness:** use cloud providers, Ollama, llama.cpp, vLLM, or SGLang while keeping Jazz's tools, context controls, workflows, and surfaces.
- **Plugins:** install trusted extensions for additional tool recommendations and approval decisions.

The [concepts overview](./concepts/index.md) links to each capability and how to use it.

## Exact syntax

Find commands and flags in the [command index](./commands.md). Before updating across a minor version, read [Upgrading](./upgrading.md) for the versioning policy and how breaking changes are announced. Configuration and tool details live under [Configure](./configure/index.md) and [Tools](./tools/index.md).
