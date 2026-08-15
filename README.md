<div align="center">

# Jazz

[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue.svg)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![npm version](https://img.shields.io/npm/v/jazz-ai.svg)](https://www.npmjs.com/package/jazz-ai)

### One agent. Every surface. Your rules.

An AI agent that runs on your own machine and gets things done — your inbox, your research,
your repo, your calendar. Not just for code.

[Quick Start](#quick-start) · [On GitHub](#put-it-on-your-repo-in-two-minutes) · [Where It Runs](#where-jazz-runs) · [Workflows](#workflows) · [Docs](docs/index.md) · [Discord](https://discord.gg/yBDbS2NZju)

</div>

---

## Quick Start

```bash
npm install -g jazz-ai
jazz
```

One bundled file, no build step and no container. Jazz walks you through provider setup on
first run, and it can be free: [OpenRouter](https://openrouter.ai) with the
[`Free Models Router`](https://openrouter.ai/openrouter/free) model needs no credit card,
and `ollama` runs fully local with no API key at all.

Then just ask:

```text
> check my unread email, summarize what matters, archive the rest
> deep-research the Three-Body Problem and write it into my Obsidian vault
> every morning at 7, tell me the weather and what to wear
> review the last 5 commits and flag anything risky
> find every TODO in this repo, group by priority, and open an issue for the top 3
```

Jazz plans, calls tools, checks its own work, and reports back. It keeps going when you
close the laptop, and asks for permission on your phone when it needs it.

---

## Put it on your repo in two minutes

Every pull request gets an AI review with inline, line-level comments, and you can talk to
it in the PR thread. Copy two paths into your repo:

```bash
curl -L https://github.com/lvndry/jazz/archive/main.tar.gz | \
  tar -xz --strip=1 jazz-main/.github/jazz jazz-main/.github/workflows/jazz.yml
```

Add one repo secret — `OPENROUTER_API_KEY` or `OPENAI_API_KEY` — and you're done.
`GITHUB_TOKEN` comes free with Actions. Open a PR and the review posts itself.

```text
/jazz-review               re-run the review
/jazz why does X work?     ask anything about the PR or the codebase
```

This is how every PR in this repo gets reviewed, including the ones that changed this
README. Release notes are drafted the same way from the commits since the last tag.
Customizing the reviewer for your stack: [`.github/jazz/README.md`](.github/jazz/README.md).

---

## Where Jazz runs

Your agent isn't trapped in a terminal. One command, `jazz run`, sits behind every surface
below, so a script, a bot, and a CI job all talk to the same agent the same way.

| Surface              | How you run it                                                                  |
| -------------------- | ------------------------------------------------------------------------------- |
| Terminal             | `jazz`                                                                          |
| Scripts & pipes      | `jazz run --json --agent dev "…"`                                               |
| Cron / launchd       | `jazz workflow schedule <name>`                                                 |
| GitHub PRs & Actions | [`.github/jazz/`](.github/jazz/), reviews every PR in this repo                 |
| Telegram             | [`integrations/telegram-bot/`](integrations/telegram-bot/), `docker compose up` |
| Discord              | [`integrations/discord-bot/`](integrations/discord-bot/), `docker compose up`   |

Want Slack, Google Chat, or your own app instead? The same `jazz run` contract works there too, as
a bridge you write yourself (~100 lines). See [Chat platforms](docs/surfaces/chat-platforms.md).

---

## Any model, or none of them

Every major LLM provider, plus `ollama` and `llama.cpp` for running models locally with no
API key. Switch with `/model` mid-conversation, or point different agents at different
providers. Full list: [Providers](docs/integrations/providers.md).

Fully airgapped mode is supported: `JAZZ_OFFLINE=1` stops all outbound requests except
inference itself. See [Airgapped & Self-Hosted](docs/guide/airgapped.md).

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

Jazz schedules through `launchd` on macOS and `cron` on Linux. If your laptop was asleep at
9am, a workflow with `catchUpOnStartup` offers to run what it missed the next time you use
Jazz, so a personal machine works as a scheduler. Three workflows ship built in —
inbox cleanup, market analysis, morning weather — and the
[Cookbook](docs/cookbook/index.md) has seven more to copy.

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

## Safety & permissions

Nothing runs without a say-so. One dial controls what's allowed to run unattended, for the
terminal, CI, and any bot the same way:

| Policy      | Auto-approves                                       |
| ----------- | --------------------------------------------------- |
| `false`     | Nothing, always asks                                |
| `read-only` | Reading files, search, web requests                 |
| `low-risk`  | + todo tracking, spawning sub-agents                |
| `high-risk` | + file changes, shell commands, git commit and push |

Every gated action is proposed before it executes, so you see exactly what will happen
before it happens. Details: [Tools & approval](docs/internals/tools-and-approval.md).
Reporting a vulnerability: [SECURITY.md](SECURITY.md).

---

## The headless contract

Why the bridges stay small: stdout carries the payload, stderr carries everything else. No
mode flags, no log lines to filter out of your JSON.

```bash
jazz run --json --agent dev --conversation "$THREAD_ID" --approval-policy read-only "review this diff"
```

```jsonc
{ "ok": true, "answer": "…", "costUSD": 0.000182, "toolCalls": [] }
```

One line, one object, whether the run succeeded or failed. `--conversation <any-id>` makes
it stateful — pass a chat id, a thread id, or a ticket number and Jazz owns the transcript,
so your bridge stores nothing. `--events tools,subagent` adds NDJSON progress on stderr
while stdout stays clean.

The event stream runs both ways. A gated tool emits `approval_required` with a
`toolCallId` and the run blocks; write an `approval_decision` line back on stdin and it
continues. That round-trip is the whole mechanism behind approving a paused server job
from a chat message.

Long runs are budgeted: an 80-iteration ceiling that injects wrap-up pressure at 70% and
90%, loop and meltdown detection, context compaction at 80% of the window, sub-agents with
isolated context, and cost on every run with a daily cap. Built on TypeScript and
[Effect-TS](https://effect.website/), so failures have a typed recovery path.

[Headless contract](docs/surfaces/headless.md) ·
[Agent loop](docs/internals/agent-loop.md) ·
[Design decisions](docs/internals/design-decisions.md)

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

| Topic           | Links                                                                                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Getting started | [Quick Start](docs/guide/quick-start.md) · [Creating Agents](docs/guide/creating-agents.md)                                                                                                                |
| Where it runs   | [Surfaces](docs/surfaces/index.md) · [Headless](docs/surfaces/headless.md) · [Chat platforms](docs/surfaces/chat-platforms.md) · [CI/CD](docs/surfaces/ci-cd.md) · [Scheduled](docs/surfaces/scheduled.md) |
| Examples        | [Use Cases](docs/guide/index.md#end-to-end-use-cases) · [Cookbook](docs/cookbook/index.md) · [Examples](examples/)                                                                                         |
| Concepts        | [Agents](docs/concepts/agents.md) · [Personas](docs/concepts/personas.md) · [Skills](docs/concepts/skills.md) · [Tools](docs/concepts/tools.md) · [Workflows](docs/concepts/workflows.md)                  |
| Self-hosting    | [Airgapped](docs/guide/airgapped.md) · [Telegram bridge](integrations/telegram-bot/) · [Discord bridge](integrations/discord-bot/)                                                                         |
| Reference       | [CLI](docs/reference/cli.md) · [Configuration](docs/reference/configuration.md) · [Tools](docs/reference/tools.md)                                                                                         |
| Internals       | [Agent loop](docs/internals/agent-loop.md) · [Context management](docs/internals/context-management.md) · [Design decisions](docs/internals/design-decisions.md)                                           |

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
