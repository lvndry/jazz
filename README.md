<div align="center">

# Jazz

[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue.svg)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![npm version](https://img.shields.io/npm/v/jazz-ai.svg)](https://www.npmjs.com/package/jazz-ai)

### One agent. Every surface. Your rules.

**Jazz is an AI agent you install once and run everywhere** — in your terminal, in your
CI pipeline, on a cron schedule, in a Telegram thread, on a pull request. Same agent,
same tools, same memory. Any model you want, including local ones. No account, no
vendor, no per-seat pricing.

[Quick Start](#60-second-start) · [Every Surface](#one-agent-every-surface) · [Long Runs](#built-for-long-runs) · [Automate It](#automate-it-workflows) · [Docs](docs/index.md) · [Discord](https://discord.gg/yBDbS2NZju)

<img src="assets/jazz_demo_800.gif" alt="Jazz running in the terminal" width="800">

</div>

---

## Why this isn't another chatbot

A chatbot answers you. Jazz **does the thing** — and it does it wherever the work
actually happens, not just in a chat window you have to visit.

|  | What that means |
| --- | --- |
| **🔀 It runs anywhere** | One binary is a terminal REPL, a headless one-shot command, a webhook backend, a GitHub Actions reviewer, and a cron daemon. Same agent config behind all of them. |
| **🔓 It's locked to nobody** | 18 LLM providers behind one interface. Switch model mid-conversation. Run 100% local with Ollama or llama.cpp. Nothing about Jazz assumes a specific vendor. |
| **🏠 It's yours** | MIT-licensed, `npm install`-able, runs on your machine or your server. Fully airgapped mode. Every transcript, log, and credential stays on disk you own. |
| **⏱️ It finishes long jobs** | Iteration budgets, automatic context compaction, sub-agents, loop detection, cost accounting. Built to survive a 40-minute autonomous run, not a single reply. |

You describe the outcome. Jazz plans, calls tools, checks its own work, and reports back.

---

## 60-second start

```bash
npm install -g jazz-ai
jazz
```

Jazz walks you through provider setup on first run. Keep it current with `jazz update`.

> **Want it free?** Pick [OpenRouter](https://openrouter.ai) as your provider and the
> [`Free Models Router`](https://openrouter.ai/openrouter/free) model. No credit card.
> **Want it private?** Pick `ollama` and everything — model included — stays on your machine.

Then just talk to it:

```
> review the last 5 commits and flag anything risky
> check my unread email, summarize what matters, archive the rest
> deep-research the Three-Body Problem and write it into my Obsidian vault
> find every TODO in this repo, group by priority, and open an issue for the top 3
```

---

## One agent, every surface

This is the part that makes Jazz different. Your agent isn't trapped in a terminal.

| Surface | How you run it | Status |
| --- | --- | --- |
| **Terminal** — interactive, streaming, full TUI | `jazz` | ✅ Shipped |
| **Scripts & pipes** — one-shot, clean stdout, JSON envelope | `jazz run --json --agent dev "…"` | ✅ Shipped |
| **Cron / launchd** — unattended scheduled runs, with catch-up | `jazz workflow schedule <name>` | ✅ Shipped |
| **GitHub PRs & Actions** — inline code review, `/jazz <question>` on any PR | [`.github/jazz/`](.github/jazz/) | ✅ Shipped — reviews every PR in *this* repo |
| **Telegram** — full agent in a DM, per-user models, reminders, live progress | [`integrations/telegram-bot/`](integrations/telegram-bot/) | ✅ `docker compose up` |
| **Slack · Google Chat · Discord · your own app** | your webhook handler → `jazz run` | 🔧 Bring your own bridge (~100 lines) |

### The one primitive behind all of it

Every non-terminal surface is the same trick. `jazz run` puts **the answer on stdout and
every bit of noise on stderr**, so any transport that can spawn a process and post a
string is a complete Jazz client:

```bash
jazz run --json --agent assistant --conversation "$CHAT_ID" "$USER_MESSAGE"
```

```json
{ "ok": true, "answer": "…", "costUSD": 0.0042, "tokenUsage": { … }, "toolCalls": [ … ] }
```

- `--conversation <id>` gives a **stateless webhook per-chat memory** — pass the chat id and Jazz loads and saves that thread's history for you. Your bridge stores nothing.
- `--approval-policy read-only|low-risk|high-risk` is the autonomy dial for unattended runs.
- `--events tools,reasoning,subagent` streams NDJSON progress on stderr, so you can render a live "thinking…" bubble while stdout stays clean.
- `--timeout`, `--max-iterations`, `--reasoning` bound each run.

That's the whole integration contract — documented in full in
[Surfaces → Headless](docs/surfaces/headless.md). The
[Telegram bridge](integrations/telegram-bot/) is a complete, production-deployed reference
implementation of it — copy it, swap the transport, and you have Slack or Discord
([how](docs/surfaces/chat-platforms.md)).

---

## Not locked in

**18 providers, one interface:** OpenAI, Anthropic, Google, xAI, Mistral, DeepSeek, Groq,
Cerebras, Fireworks, TogetherAI, OpenRouter, Vercel AI Gateway, Alibaba, Moonshot,
MiniMax, Zhipu — plus **Ollama** and **llama.cpp** for local inference.

Switch models with `/model` mid-conversation. Give an agent a cheap model for
summarization and an expensive one for reasoning. Point at any OpenAI-compatible
endpoint you host yourself.

**Fully airgapped:** set `JAZZ_OFFLINE=1` and Jazz never makes an outbound request of its
own — no update check, no model-catalog fetch. Pair it with local Ollama and the whole
stack, model included, runs inside your network. Telemetry is local JSON files that never
leave the box. See [Airgapped & Self-Hosted](docs/guide/airgapped.md).

---

## Built for long runs

The difference between a chat wrapper and an agent harness shows up around minute ten.
Jazz is engineered for the tasks that take a while:

- **Iteration budgets with soft pressure.** At 70% of its budget Jazz tells itself to start consolidating; at 90%, to write the final answer now. The nudge is ephemeral — it steers the run without polluting the transcript.
- **Loop detection.** If recent tool calls stop being diverse (same tool, same arguments, over and over), Jazz notices it's spiralling and breaks out — while still treating `search → fetch → search with a new query` as genuine progress.
- **Automatic context compaction.** As the window fills, Jazz summarizes and continues instead of truncating. Trimming is turn-aware, so a tool call is never split from its result. You can point compaction at a cheaper model.
- **Sub-agents with isolated context.** `spawn_subagent` hands a research or coding task to a child agent with its own window; it can burn 100k tokens and hand back a paragraph. Parallel sub-agents show up as their own panels.
- **Real cost accounting.** Per-run tokens and USD, per-model, with a daily spend cap for unattended deployments.

Under the hood it's 100% TypeScript on [Effect-TS](https://effect.website/): typed errors,
tracked effects, and a recovery path for every failure instead of a silent `undefined`.

How each of these works, and what it trades away: [Agent loop](docs/internals/agent-loop.md) ·
[Context management](docs/internals/context-management.md) ·
[Design decisions](docs/internals/design-decisions.md).

---

## What it can actually do

**43 built-in tools** — filesystem (read, write, surgical edit, find, grep, PDF), git
(status, diff, commit, branch, merge, push, blame, reflog, tag), shell execution, web
search, web fetch, HTTP requests, todo tracking, and sub-agent spawning. Every one is
listed with its risk tier in the [Tools reference](docs/reference/tools.md).

**Skills — packaged expertise, loaded on demand.** Proven playbooks instead of winging it:
deep research with multi-source verification, structured code review, meeting notes in
your format, commit messages in your convention. Jazz ships 18+ and follows the
[`.agents` convention](https://agentskills.io), so anything from the ecosystem works.
Drop one in `~/.jazz/skills/` or `./skills/`, or run `npx skills add`. Loading is
progressive — Jazz finds a skill, then pulls only the sections it needs, so having a
hundred skills costs you nothing in context.

**MCP — connect to everything else.** Jazz speaks
[Model Context Protocol](https://modelcontextprotocol.io/). Run `jazz mcp add` and paste
a config:

```json
{
  "mcpServers": {
    "notion": { "command": "npx", "args": ["-y", "mcp-remote", "https://mcp.notion.com/mcp"] },
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }
  }
}
```

Servers connect lazily — only when an agent actually reaches for one of their tools.

---

## Automate it: workflows

A workflow is a Markdown file that says what to do, when to do it, and how much autonomy
it gets. Schedule it and forget it.

```yaml
---
name: daily-standup-prep
description: Prepare my daily standup notes
schedule: "0 9 * * 1-5" # 9 AM, weekdays
agent: my-dev-agent
autoApprove: read-only
---
```

```markdown
Check my git activity from yesterday across all repos in ~/projects/.
Summarize what I worked on, PRs I opened or reviewed, and any blockers.
Format it as bullet points I can paste into Slack.
```

```bash
jazz workflow schedule daily-standup-prep
```

Jazz uses `launchd` on macOS and `cron` on Linux, and can catch up runs your laptop
slept through. Three workflows ship built in (email cleanup, weather briefing, market
analysis), and the **[Cookbook](docs/cookbook/index.md)** has seven more copy-pasteable
recipes — inbox triage, PR watchdog, competitor watch, tech-debt radar, research digest.

---

## We use Jazz to build Jazz

Jazz reviews its own pull requests. The [`jazz.yml`](.github/workflows/jazz.yml) workflow
installs `jazz-ai` in the runner, runs a review agent against the PR diff, and posts
**inline, line-level comments** — checking correctness, security, TypeScript and
Effect-TS patterns, and performance. Comment `/jazz-review` to re-run it, or
`/jazz <anything>` to ask the PR assistant a question grounded in the actual diff.

Every release's notes are written the same way: a Jazz agent reads the commits since the
last tag and drafts the GitHub Release.

```yaml
- run: npm install -g jazz-ai
- run: jazz --output raw workflow run my-review --auto-approve
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Copy [`.github/jazz/`](.github/jazz/) and [`jazz.yml`](.github/workflows/jazz.yml) into
your repo, add one provider secret, and you have the same thing. Setup guide:
[`.github/jazz/README.md`](.github/jazz/README.md).

---

## You stay in control

Jazz never acts without a say-so. Tools are classified by risk, and one dial decides how
much runs unattended — the same dial for your terminal, your CI job, and your bot:

| Policy | Auto-approves |
| --- | --- |
| `false` | Nothing — always asks |
| `read-only` | Reading files, search, web requests, `git status`/`log`/`diff` |
| `low-risk` | + todo tracking, spawning sub-agents |
| `high-risk` | + file changes, shell commands, git commit and push |

Approval is two-phase — propose, then execute — so interactive and headless runs go
through exactly the same code path. Every action is logged; you see the full argument list
before anything happens. Credentials stay local (OAuth2 for Gmail, API keys in your
config). See [Tools & approval](docs/internals/tools-and-approval.md) and
[SECURITY.md](SECURITY.md) — which covers both running Jazz safely and reporting a
vulnerability.

---

## Command reference

```bash
jazz                              # start chatting
jazz run --agent <a> "<prompt>"   # one-shot, headless (add --json for scripts)
jazz agent create|list|show|edit|delete|chat
jazz workflow list|show|run|schedule|unschedule|scheduled|catchup|history
jazz mcp add|list|remove|enable|disable
jazz persona create|list|show|edit|delete
jazz config show|get|set
jazz update
```

**In chat:** `/tools` `/skills` `/model` `/mode` `/cost` `/context` `/compact` `/switch`
`/workflows` — or `/help`. Full details in the [CLI Reference](docs/reference/cli.md).

---

## Documentation

Full docs: **[`docs/index.md`](docs/index.md)**

| I want to… | Go to |
| --- | --- |
| **Get running** | [Quick Start](docs/guide/quick-start.md) · [Creating Agents](docs/guide/creating-agents.md) |
| **See where it can run** | [Surfaces](docs/surfaces/index.md) · [Headless (`jazz run`)](docs/surfaces/headless.md) · [Chat platforms](docs/surfaces/chat-platforms.md) · [CI/CD](docs/surfaces/ci-cd.md) · [Scheduled](docs/surfaces/scheduled.md) |
| **See it solve something real** | [Use Cases](docs/guide/index.md#end-to-end-use-cases) · [Cookbook](docs/cookbook/index.md) · [Examples](examples/) |
| **Understand the building blocks** | [Agents](docs/concepts/agents.md) · [Skills](docs/concepts/skills.md) · [Workflows](docs/concepts/workflows.md) · [Personas](docs/concepts/personas.md) · [Scheduling](docs/concepts/scheduling.md) |
| **Run it my way** | [Airgapped & Self-Hosted](docs/guide/airgapped.md) · [Telegram bridge](integrations/telegram-bot/) · [GitHub Actions](.github/jazz/README.md) |
| **Look up a flag or tool** | [CLI Reference](docs/reference/cli.md) · [Configuration](docs/reference/configuration.md) · [Tools](docs/reference/tools.md) · [Workflow frontmatter](docs/reference/workflow-frontmatter.md) |
| **See how it works inside** | [Internals](docs/internals/index.md) · [Agent loop](docs/internals/agent-loop.md) · [Context management](docs/internals/context-management.md) · [Design decisions](docs/internals/design-decisions.md) |
| **Know what's coming** | [Discussions](https://github.com/lvndry/jazz/discussions) · [Issues](https://github.com/lvndry/jazz/issues) |

**Community:** [Discord](https://discord.gg/yBDbS2NZju) ·
[Discussions](https://github.com/lvndry/jazz/discussions) ·
[Issues](https://github.com/lvndry/jazz/issues)

---

## Contributing

Bug fixes, docs, tests, features, and ideas all welcome — see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT — see [`LICENSE`](LICENSE).

---

<div align="center">

**One agent. Every surface.**

```bash
npm install -g jazz-ai && jazz
```

[Back to top](#jazz)

</div>
