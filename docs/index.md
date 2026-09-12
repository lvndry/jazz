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

The first run asks you to choose a model provider and creates an agent. You can then ask it to inspect files, work with git, read the web, or create artifacts. See the [quick start](./getting-started/quick-start.md) for the complete first session.

## Choose what you need

- **New to Jazz:** [install it and complete your first useful run](./getting-started/index.md).
- **Evaluating Jazz:** [browse its features](./features/index.md) and [compare where it runs](./surfaces/index.md).
- **Building an agent:** understand the [core concepts](./concepts/index.md), then [configure Jazz](./configure/index.md).
- **Solving a real job:** copy a maintained [guide](./guides/index.md).
- **Operating it safely:** read the [security model](./security/index.md).
- **Contributing:** trace the implementation in the [maintainer guide](./maintainers/index.md).

## What makes Jazz different

Jazz is not a chat wrapper. It adds the machinery required for useful work: tool execution with approval boundaries, context management for long runs, durable work state, scheduling, per-conversation history, model-provider portability, and multiple user-facing surfaces.

- **One agent, every surface:** define an agent once and use it from the terminal, CI, schedules, bots, webhooks, or another agent.
- **Built for automation:** `jazz run` keeps stdout clean, streams structured events to stderr, returns explicit exit codes, and supports JSON envelopes and run budgets.
- **More than one generic assistant:** create multiple agents with different models, personas, tools, memory scopes, and safety ceilings.
- **Several models inside one identity:** bind separate companions for image, audio, and video understanding or generation while the primary model keeps the plan, tools, memory, and conversation.
- **Approvals that survive unattended work:** decline safely, ask on an interactive surface, or park a run and resume it after remote approval.
- **Provider choice without losing the harness:** use cloud providers, Ollama, or llama.cpp while keeping Jazz's tools, context controls, workflows, and surfaces.
- **Harness quality you can measure:** the eval suite tests whether context, prompts, and tools improve task reliability instead of assuming a change helped.

The [features overview](./features/index.md) explains those capabilities without requiring you to read the implementation.

## Exact syntax

Commands and flags are collected in the generated [command index](./commands.md). Configuration and tool details live under [Configure](./configure/index.md) and [Tools](./tools/index.md), where examples are checked against the code.
