<div align="center">

# Jazz

[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue.svg)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![npm version](https://img.shields.io/npm/v/jazz-ai.svg)](https://www.npmjs.com/package/jazz-ai)

### One agent. Every surface. Your rules.

Most coding agents assume you're sitting there. Jazz assumes you're not. One install runs
in your terminal, on a cron, inside CI, and behind a chat bot — same agent, same tools,
same memory, one approval dial that means the same thing everywhere.

[Quick Start](#quick-start) · [Where It Runs](#where-jazz-runs) · [Unattended runs](#built-for-runs-youre-not-watching) · [Workflows](#workflows) · [Docs](docs/index.md) · [Discord](https://discord.gg/yBDbS2NZju)

</div>

---

## Why Jazz?

Every serious agent can call tools. The hard part is trusting one to run when nobody is
watching, and that is the part Jazz is designed around.

- **It declines instead of hanging.** An unattended run has nobody to ask, so tools above your approval tier are refused and the agent routes around them. No job ever blocks forever on a prompt nobody will answer.
- **It remembers without a database.** Pass `--conversation <any-id>` and Jazz owns the transcript. A Telegram chat, a Slack thread, or a ticket number becomes stateful in one flag, and your bridge stores nothing.
- **It accounts for itself.** Every run reports what it spent — including the runs that failed, because a job that timed out still cost money. Set a daily cap and walk away.
- **It survives long jobs.** A budgeted iteration count that warns itself to wrap up, loop detection, automatic context compaction, and sub-agents that keep research out of the parent's context.

You describe the outcome. Jazz plans, calls tools, checks its own work, and reports back.

---

## Quick Start

```bash
npm install -g jazz-ai
jazz
```

Jazz walks you through provider setup on first run. Update anytime with `jazz update`.
The CLI ships as one bundled file: no build step, no Python environment, no container.

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

## Built for runs you're not watching

The contract behind `jazz run` is what keeps those integrations small: **stdout carries the
payload, stderr carries everything else.** No mode flags to remember, no log lines to
filter out of your JSON.

```bash
jazz run --json --agent dev --conversation "$THREAD_ID" --approval-policy read-only "review this diff"
```

```jsonc
{ "ok": true, "answer": "…", "costUSD": 0.000182, "toolCalls": [] }
```

Exactly one line, one object, on success _and_ on failure. Add `--events tools,subagent`
for NDJSON progress on stderr while stdout stays pristine, so a bot can render a live
progress bubble and still parse the result cleanly.

Underneath it: an 80-iteration budget that injects wrap-up pressure at 70% and 90%, loop
and meltdown detection, context compaction at 80% of the window, and sub-agents with
isolated context. Built on TypeScript and [Effect-TS](https://effect.website/), so
failures have a typed recovery path instead of crashing silently.

[Headless contract](docs/surfaces/headless.md) ·
[Agent loop](docs/internals/agent-loop.md) ·
[Design decisions](docs/internals/design-decisions.md)

---

## Any model, or none of them

Every major LLM provider, plus `ollama` and `llama.cpp` for running models locally with no
API key. Switch with `/model` mid-conversation, or point different agents at different
providers. Full list: [Providers](docs/integrations/providers.md).

Fully airgapped mode is supported: `JAZZ_OFFLINE=1` stops all outbound requests except
inference itself. See [Airgapped & Self-Hosted](docs/guide/airgapped.md).

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
