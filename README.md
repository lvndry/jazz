<div align="center">

# Jazz

### One agent. Every surface. Your rules.

[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue.svg)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![npm version](https://img.shields.io/npm/v/jazz-ai.svg)](https://www.npmjs.com/package/jazz-ai)

![Jazz in the terminal](docs/assets/jazz_demo_github.gif)

</div>

Jazz is an agent harness: the loop, guardrails, and surfaces that turn a model into an
agent you can run unattended. You define the agent — a model, a persona, a toolset, and
permissions in one JSON file — and Jazz runs it in your terminal, from scripts, on a
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

## Get started

```bash
curl -fsSL https://github.com/lvndry/jazz/releases/latest/download/install.sh | bash
jazz
```

That installs a single self-contained binary into `~/.local/bin` — no Node, no npm, nothing
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

Then ask it for what you want. These work the moment the wizard finishes — no extra keys,
no extra installs:

```text
> give me the TL;DR of ~/Desktop/bitcoin.pdf
> review the last 5 commits and flag anything risky
> fetch https://en.wikipedia.org/wiki/Jazz and give me the short version
```

On priced models, every answer ends with what it actually cost you — real numbers
from your own key.

With a minute of setup each, Jazz also does the bigger jobs:

```text
> check my unread email, summarize what matters, archive the rest         # after `himalaya` is configured
> deep-research the Three-Body Problem and write it into my Obsidian vault # after a web-search key is set
> every morning at 7, tell me the weather and what to wear                 # as a scheduled workflow
```

The [Cookbook](docs/cookbook/index.md) walks through each one.

## Where it runs

| Surface              | How you run it                                                                  |
| -------------------- | ------------------------------------------------------------------------------- |
| Terminal             | `jazz`                                                                          |
| Scripts & pipes      | `jazz run --json --agent dev "…"`                                               |
| Cron / launchd       | `jazz workflow schedule <name>`                                                 |
| GitHub PRs & Actions | [`.github/jazz/`](.github/jazz/), reviews every PR in this repo                 |
| Telegram             | [`packages/telegram-bot/`](packages/telegram-bot/), `docker compose up` |
| Discord              | [`packages/discord-bot/`](packages/discord-bot/), `docker compose up`   |

Slack, Google Chat, or your own app work the same way. See
[Chat platforms](docs/surfaces/chat-platforms.md).

## Documentation

Start at [`docs/index.md`](docs/index.md).

- [Quick start](docs/guide/quick-start.md) and [creating agents](docs/guide/creating-agents.md)
- [Cookbook](docs/cookbook/index.md), ready-made workflows to copy
- [Skills](docs/concepts/skills.md), [tools](docs/concepts/tools.md), and [workflows](docs/concepts/workflows.md)
- [Safety and approvals](docs/internals/tools-and-approval.md)
- [Headless runs](docs/surfaces/headless.md), the contract behind every surface
- [Airgapped and self-hosted](docs/guide/airgapped.md)
- [CLI](docs/reference/cli.md) and [configuration](docs/reference/configuration.md) reference
- [Design decisions](docs/internals/design-decisions.md), why it is built this way

## Community

[Discord](https://discord.gg/yBDbS2NZju) ·
[Discussions](https://github.com/lvndry/jazz/discussions) ·
[Issues](https://github.com/lvndry/jazz/issues) ·
[Contributing](CONTRIBUTING.md) ·
[Security](SECURITY.md)

MIT licensed. See [`LICENSE`](LICENSE).
