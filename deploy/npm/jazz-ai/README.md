<div align="center">

# Jazz

### One agent. Every surface. Your rules.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/jazz-ai.svg)](https://www.npmjs.com/package/jazz-ai)

</div>

Jazz is an open-source AI agent harness for running tool-using models interactively, in scripts and
CI, on schedules, through webhooks, or behind chat services you own. An agent keeps the same
persona, tools, memory, limits, and approval policy on every surface.

## Install and run

```bash
npm install -g jazz-ai
jazz
```

The npm package installs the native binary for macOS or Linux. The first run walks through model
provider and agent setup. You can also install the standalone release without npm from the
[Jazz repository](https://github.com/lvndry/jazz).

```text
> summarize ~/Desktop/report.pdf and identify unsupported claims
> review the last five commits and show me the risky changes
> research the current options, cite sources, and save a decision brief
```

## What Jazz unlocks

- **One agent across many surfaces.** Use the terminal, `jazz run --json`, GitHub Actions,
  launchd or cron, Telegram, Discord, iMessage, WhatsApp, webhooks, and agent-to-agent peers.
- **Composable models.** Keep one primary reasoning model and bind specialist companions for image,
  audio, and video understanding or generation.
- **Model and provider choice.** Use OpenAI, Anthropic, Google, Mistral, Groq, OpenRouter, local
  Ollama or llama.cpp models, and more.
- **Real unattended operation.** Machine-readable output, stable exit states, named conversations,
  budgets, resumable approvals, and explicit headless policies make agents usable in CI and
  production automation.
- **Personas, skills, peers, and subagents.** Reuse behavior independently of models, load expertise
  only when needed, and split work across bounded or remotely trusted agents.
- **Owned deployment and security boundary.** Jazz runs on your infrastructure; tools declare risk,
  disclosure, and egress while per-agent denials provide a hard capability ceiling.

## Useful entry points

- [`jazz`](https://github.com/lvndry/jazz/blob/main/docs/getting-started/quick-start.md): interactive terminal
- `jazz run --json --agent reviewer "Review this checkout"`: scripts and CI
- `jazz workflow schedule daily-briefing`: recurring work
- `jazz imessage` or `jazz imessage --local`: hosted or local-Mac iMessage
- `jazz whatsapp`: linked-device WhatsApp

Start with the [Jazz documentation](https://github.com/lvndry/jazz/blob/main/docs/index.md), then
explore [features](https://github.com/lvndry/jazz/blob/main/docs/features/index.md),
[complete tutorials](https://github.com/lvndry/jazz/blob/main/docs/guides/index.md),
[agent configuration](https://github.com/lvndry/jazz/blob/main/docs/configure/agents.md), and the
[security model](https://github.com/lvndry/jazz/blob/main/SECURITY.md).

## Community

[Discord](https://discord.gg/yBDbS2NZju) ·
[Discussions](https://github.com/lvndry/jazz/discussions) ·
[Issues](https://github.com/lvndry/jazz/issues) ·
[Contributing](https://github.com/lvndry/jazz/blob/main/CONTRIBUTING.md)

MIT licensed.
