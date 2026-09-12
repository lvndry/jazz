<div align="center">

# Jazz

### One agent. Every surface. Your rules.

[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue.svg)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![npm version](https://img.shields.io/npm/v/jazz-ai.svg)](https://www.npmjs.com/package/jazz-ai)

![Jazz in the terminal](docs/assets/jazz_demo_github.gif)

</div>

Jazz is an agent harness: the loop, guardrails, and surfaces that turn a model into an
agent you can run unattended. You define the agent: primary and companion models, a persona, tools, and
permissions in one JSON file, and Jazz runs it in your terminal, from scripts, on a
schedule, or behind a Telegram or Discord bot you own. Out of the box an agent works with
your files, git, and the web; connect an inbox, an Obsidian vault, or a search provider and
it grows into an everyday assistant.

Install it once and it runs everywhere. A terminal REPL, a one-shot command inside a script,
a scheduled workflow, a GitHub Action that reviews your pull requests, or a Telegram and
Discord bot on a server you own. Same agent, same tools, same memory. When a job needs your
permission it asks you wherever you are, rather than stopping.

18 providers are supported, including OpenAI, Anthropic, Google, Mistral, Groq, and
OpenRouter, plus `ollama` and `llama.cpp` for local models with no API key. Everything else
connects through [MCP](https://modelcontextprotocol.io/).

One agent can compose different models by capability: keep the model you trust for reasoning and
tools, then bind separate companions for image, audio, and video understanding or generation.
The persona, memory, permissions, and surface stay the same while each medium goes to the model
best suited to it.

## Get started

```bash
curl -fsSL https://github.com/lvndry/jazz/releases/latest/download/install.sh | bash
jazz
```

That installs a single self-contained binary into `~/.local/bin`: no Node, no npm, nothing
else to install. Set `JAZZ_INSTALL_DIR` to put it somewhere else. If you would rather go
through npm:

```bash
npm install -g jazz-ai
jazz
```

Either way, `jazz update` upgrades in place.

Jazz walks you through provider setup on first run. It can cost nothing:
[OpenRouter](https://openrouter.ai)'s [free models router](https://openrouter.ai/openrouter/free)
needs no credit card, and `ollama` runs entirely on your own hardware.

Then ask it for what you want. These work the moment the wizard finishes: no extra keys,
no extra installs:

```text
> give me the TL;DR of ~/Desktop/bitcoin.pdf
> review the last 5 commits and flag anything risky
> fetch https://en.wikipedia.org/wiki/Jazz and give me the short version
```

When provider pricing is known, each answer reports its actual cost from your own key; unknown
pricing is marked unknown rather than presented as free.

With a minute of setup each, Jazz also does the bigger jobs:

```text
> check my unread email, summarize what matters, archive the rest         # after `himalaya` is configured
> deep-research the Three-Body Problem and write it into my Obsidian vault # after a web-search key is set
> every morning at 7, tell me the weather and what to wear                 # as a scheduled workflow
```

The [guides](docs/guides/index.md) walk through complete setups.

## Where it runs

| Surface              | How you run it                                                                     |
| -------------------- | ---------------------------------------------------------------------------------- |
| Terminal             | `jazz`                                                                             |
| Scripts & pipes      | `jazz run --json --agent dev "…"`                                                  |
| Cron / launchd       | `jazz workflow schedule <name>`                                                    |
| GitHub PRs & Actions | [`.github/jazz/`](.github/jazz/), reviews every PR in this repo                    |
| Telegram             | [`packages/telegram-bot/`](packages/telegram-bot/), `docker compose up`            |
| Discord              | [`packages/discord-bot/`](packages/discord-bot/), `docker compose up`              |
| iMessage             | `jazz imessage` (hosted Photon line) or `jazz imessage --local` (your Mac account) |
| WhatsApp             | [`packages/whatsapp-bot/`](packages/whatsapp-bot/), `jazz whatsapp`                |

Slack, Google Chat, or your own app work the same way. See
[Chat platforms](docs/surfaces/chat.md).

## Documentation

Start at [`docs/index.md`](docs/index.md).

- [Getting started](docs/getting-started/index.md): install, first run, and first custom agent
- [Features](docs/features/index.md): what Jazz unlocks and why the harness matters
- [Surfaces](docs/surfaces/index.md): terminal, headless, schedules, CI, chat, webhooks, and peers
- [Concepts](docs/concepts/index.md): agents, personas, tools, skills, workflows, and memory
- [Guides](docs/guides/index.md): complete setups you can run
- [Security](docs/security/index.md): permissions, approvals, secrets, egress, and remote access
- [Configure](docs/configure/index.md): models, agents, workflows, MCP, search, and telemetry
- [Maintainers](docs/maintainers/index.md): code-backed architecture and runtime traces

## Community

[Discord](https://discord.gg/yBDbS2NZju) ·
[Discussions](https://github.com/lvndry/jazz/discussions) ·
[Issues](https://github.com/lvndry/jazz/issues) ·
[Contributing](CONTRIBUTING.md) ·
[Security](SECURITY.md)

MIT licensed. See [`LICENSE`](LICENSE).
