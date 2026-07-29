<div align="center">

# Jazz

[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue.svg)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![npm version](https://img.shields.io/npm/v/jazz-ai.svg)](https://www.npmjs.com/package/jazz-ai)

### One agent. Every surface. Your rules

Jazz is an AI agent you install once and run everywhere: your terminal, a CI pipeline, a
cron schedule, a Telegram thread, a pull request. Same agent, same tools, same memory,
any model.

[Quick Start](#quick-start) · [Where It Runs](#where-jazz-runs) · [Reliability](#reliability) · [Workflows](#workflows) · [Docs](docs/index.md) · [Discord](https://discord.gg/yBDbS2NZju)

</div>

---

## Why Jazz?

A chatbot answers you. Jazz does the thing, wherever the work actually happens.

- **Runs anywhere**: the same agent works in your terminal, in a script, on a schedule, on a pull request, or behind a chat bot.
- **Any model**: every major provider, swap mid-conversation, or run fully local with no API key.
- **Yours**: MIT-licensed, runs on your own machine or server, works offline, nothing leaves your disk.
- **Built for long jobs**: tracks its own progress, summarizes as it goes, delegates to helper agents, and tells you what it spent.

You describe the outcome. Jazz plans, calls tools, checks its own work, and reports back.

---

## Quick Start

```bash
npm install -g jazz-ai
jazz
```

Jazz walks you through provider setup on first run. Update anytime with `jazz update`.

Free option: [OpenRouter](https://openrouter.ai) with the
[`Free Models Router`](https://openrouter.ai/openrouter/free) model, no credit card. Private
option: `ollama`, fully local.

```text
> review the last 5 commits and flag anything risky
> check my unread email, summarize what matters, archive the rest
> deep-research the Three-Body Problem and write it into my Obsidian vault
> find every TODO in this repo, group by priority, and open an issue for the top 3
```

---

## Where Jazz runs

Your agent isn't trapped in a terminal. `jazz run` is the one command behind every surface
below. It prints the answer and nothing else, so any script, bot, or CI job can call it.
Full contract: [Surfaces → Headless](docs/surfaces/headless.md).

| Surface | How you run it | Status |
| --- | --- | --- |
| Terminal | `jazz` | Shipped |
| Scripts & pipes | `jazz run --json --agent dev "…"` | Shipped |
| Cron / launchd | `jazz workflow schedule <name>` | Shipped |
| GitHub PRs & Actions | [`.github/jazz/`](.github/jazz/) | Shipped, reviews every PR in this repo |
| Telegram | [`integrations/telegram-bot/`](integrations/telegram-bot/) | Shipped, `docker compose up` |
| Slack, Google Chat, Discord, your own app | your webhook → `jazz run` | Bring your own bridge (~100 lines), see [Chat platforms](docs/surfaces/chat-platforms.md) |

---

## Model providers

Every major LLM provider, plus `ollama` and `llama.cpp` for running models locally with no
API key. Switch with `/model` mid-conversation, or point different agents at different
providers. Full list: [Providers](docs/integrations/providers.md).

Fully airgapped mode is supported: `JAZZ_OFFLINE=1` stops all outbound requests except
inference itself. See [Airgapped & Self-Hosted](docs/guide/airgapped.md).

---

## Reliability

Most agent tools fall apart on tasks longer than a couple of minutes. Jazz is built for
tasks that take a while:

- **Budgeted iterations** that warn themselves to wrap up as they approach the limit.
- **Loop detection** that catches an agent repeating itself and forces a different approach.
- **Automatic context compaction** that summarizes and continues instead of truncating or crashing.
- **Sub-agents** for delegating research or coding work without blowing the parent's context.
- **Cost tracking** on every run, with a daily spend cap for unattended use.

Built on TypeScript and [Effect-TS](https://effect.website/), so failures have a typed
recovery path instead of crashing silently. Details:
[Agent loop](docs/internals/agent-loop.md) ·
[Design decisions](docs/internals/design-decisions.md).

---

## Tools & integrations

**43 built-in tools**: files, git, shell, web search and fetch, HTTP, todos, sub-agents.
Each has a documented risk level. See [Tools reference](docs/reference/tools.md).

**Skills** are playbooks the agent loads on demand: deep research, code review, meeting
notes, commit conventions. 18+ ship built in, and Jazz follows the
[`.agents` convention](https://agentskills.io), so anything from the ecosystem works. Add
your own to `~/.jazz/skills/` or `./skills/`, or run `npx skills add`.

**Personas** control tone and style independently of the model: `default`, `coder`,
`researcher`, or your own with `jazz persona create`.

**Custom tools** let you add a capability with no code: a name, a schema, and a shell
command or HTTP call in the agent's config. See
[Configuration](docs/reference/configuration.md#agent-config-customtools).

**MCP** connects Jazz to anything else. `jazz mcp add`, paste a server config, and its
tools are available to any agent that requests them.

---

## Workflows

A workflow is a Markdown file that says what to do, when, and how much autonomy it gets.

```yaml
---
name: daily-standup-prep
schedule: "0 9 * * 1-5" # weekdays, 9am
autoApprove: read-only
---
Check my git activity from yesterday and summarize what I worked on as bullet points.
```

```bash
jazz workflow schedule daily-standup-prep
```

Jazz schedules through `launchd` on macOS and `cron` on Linux, and can catch up runs your
laptop slept through. Three workflows ship built in; the
[Cookbook](docs/cookbook/index.md) has seven more ready to copy.

---

## We use Jazz to build Jazz

Every pull request to this repo is reviewed by a Jazz agent, which posts inline comments on
the diff. Comment `/jazz-review` to re-run it, or `/jazz <question>` to ask about the PR.
Release notes are drafted the same way, from the commits since the last tag.

Copy [`.github/jazz/`](.github/jazz/) and [`jazz.yml`](.github/workflows/jazz.yml) into your
own repo and add one provider secret to get the same setup. Guide:
[`.github/jazz/README.md`](.github/jazz/README.md).

---

## Safety & permissions

Nothing runs without a say-so. One dial controls what's allowed to run unattended, for the
terminal, CI, and any bot the same way:

| Policy | Auto-approves |
| --- | --- |
| `false` | Nothing, always asks |
| `read-only` | Reading files, search, web requests |
| `low-risk` | + todo tracking, spawning sub-agents |
| `high-risk` | + file changes, shell commands, git commit and push |

Every gated action is proposed before it executes, so you see exactly what will happen
before it happens. Details: [Tools & approval](docs/internals/tools-and-approval.md).
Reporting a vulnerability: [SECURITY.md](SECURITY.md).

---

## Command reference

```bash
jazz                              # start chatting
jazz run --agent <a> "<prompt>"   # one-shot, headless
jazz agent create|list|show|edit|delete|chat
jazz workflow list|show|run|schedule|unschedule|scheduled|catchup|history
jazz mcp add|list|remove|enable|disable
jazz persona create|list|show|edit|delete
jazz config show|get|set
jazz update
```

In chat: `/tools` `/skills` `/model` `/mode` `/cost` `/context` `/compact` `/switch`
`/workflows`, or `/help`. Full reference: [CLI](docs/reference/cli.md).

---

## Documentation

Start at **[`docs/index.md`](docs/index.md)**.

| Topic | Links |
| --- | --- |
| Getting started | [Quick Start](docs/guide/quick-start.md) · [Creating Agents](docs/guide/creating-agents.md) |
| Where it runs | [Surfaces](docs/surfaces/index.md) · [Headless](docs/surfaces/headless.md) · [Chat platforms](docs/surfaces/chat-platforms.md) · [CI/CD](docs/surfaces/ci-cd.md) · [Scheduled](docs/surfaces/scheduled.md) |
| Examples | [Use Cases](docs/guide/index.md#end-to-end-use-cases) · [Cookbook](docs/cookbook/index.md) · [Examples](examples/) |
| Concepts | [Agents](docs/concepts/agents.md) · [Personas](docs/concepts/personas.md) · [Skills](docs/concepts/skills.md) · [Tools](docs/concepts/tools.md) · [Workflows](docs/concepts/workflows.md) |
| Self-hosting | [Airgapped](docs/guide/airgapped.md) · [Telegram bridge](integrations/telegram-bot/) |
| Reference | [CLI](docs/reference/cli.md) · [Configuration](docs/reference/configuration.md) · [Tools](docs/reference/tools.md) |
| Internals | [Agent loop](docs/internals/agent-loop.md) · [Context management](docs/internals/context-management.md) · [Design decisions](docs/internals/design-decisions.md) |

**Community:** [Discord](https://discord.gg/yBDbS2NZju) ·
[Discussions](https://github.com/lvndry/jazz/discussions) ·
[Issues](https://github.com/lvndry/jazz/issues)

---

## Contributing

Bug fixes, docs, tests, features, and ideas all welcome. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT. See [`LICENSE`](LICENSE).

---

<div align="center">

```bash
npm install -g jazz-ai && jazz
```

[Back to top](#jazz)

</div>
