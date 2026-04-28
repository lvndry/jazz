<div align="center">

# Jazz 🎷

[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue.svg)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![npm version](https://img.shields.io/npm/v/jazz-ai.svg)](https://www.npmjs.com/package/jazz-ai)

### The agent you leave running.

![Jazz Demo](assets/jazz_demo_800.gif)

Jazz is a TypeScript CLI agent built for **scheduled, headless, CI-integrated automation**. Write a workflow as Markdown, schedule it with cron or `launchd`, and let it run while you do other things. It also does interactive chat — but that's the secondary mode.

[Quick Start](#quick-start) · [Scenarios](#what-only-jazz-does-well) · [Workflows](#workflows) · [CI/CD](#cicd) · [Docs](docs/README.md) · [Discord](https://discord.gg/yBDbS2NZju)

</div>

---

## Why Jazz?

There are a lot of good agents to pair-program with — Claude Code, Aider, Cursor CLI, Gemini CLI. Jazz is built for the other half of the day: the work you'd rather not be at the keyboard for. Workflows are first-class — Markdown files with a cron schedule, an autonomy tier, and a prompt. They run headless via `launchd` (macOS) or `cron` (Linux), with **catch-up replay** when your machine was asleep, and a `--auto-approve` flag for hands-off execution. The same binary drops into GitHub Actions: comment `/jazz` on a PR and Jazz reviews it, or runs whatever you ask. It connects to anything that speaks **MCP** (stdio or Streamable HTTP), works across 14 LLM providers via the AI SDK, and yes — you can also just type `jazz` and chat.

---

## What only Jazz does well

Three concrete things that aren't easy to do with the other CLI agents:

### 1. Cron-scheduled inbox triage

```yaml
---
name: inbox-triage
description: Archive newsletters, flag anything important
schedule: "0 8,13,18 * * *"      # 3x a day
agent: my-assistant
autoApprove: low-risk             # archive ok, send not ok
catchUpOnStartup: true            # replay missed runs after laptop sleep
---
```

```markdown
Read unread Gmail from the last 6 hours. Archive newsletters and promotions.
For anything that looks like a real human asking a real question, draft a reply
and leave it as a Gmail draft.
```

```bash
jazz workflow schedule inbox-triage
```

Jazz installs a `launchd` plist or crontab entry. If your laptop was closed at 8am, the next time you open it Jazz prompts to catch up the missed run.

### 2. PR review (and on-demand assistant) in CI

The repo's own [`.github/workflows/jazz.yml`](.github/workflows/jazz.yml) is wired up so:

- Every opened PR gets reviewed automatically.
- Commenting `/jazz` on a PR triggers a review pass.
- Commenting `/jazz <anything>` runs an assistant agent that can read the diff, the repo, and the conversation, and reply inline.

```yaml
- run: npm install -g jazz-ai
- name: Run Jazz code review
  run: jazz --output raw workflow run code-review --auto-approve --agent ci-reviewer
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

The agent configs and workflow templates live in [`.github/jazz/`](.github/jazz/). Copy them.

### 3. Multi-step MCP-driven workflows

Jazz speaks [MCP](https://modelcontextprotocol.io/) over **both** stdio and Streamable HTTP, with env sanitization on subprocess transports. So a single workflow can read your Notion roadmap, do real research, and leave a draft in Gmail:

```markdown
1. Use the Notion MCP to find this week's roadmap items.
2. For each item, search the web and any relevant academic sources.
3. Summarize findings as a Notion comment on the corresponding page.
4. Draft an email to the team with the top three insights and leave it
   as a Gmail draft. Do not send.
```

Add an MCP server with `jazz mcp add`, then any agent or workflow can use it.

---

## Quick Start

```bash
# Install
npm install -g jazz-ai
bun add -g jazz-ai
pnpm add -g jazz-ai
yarn global add jazz-ai

# Start chatting
jazz
```

That's it. Jazz walks you through provider setup on first run.

> **Try it free** — choose [OpenRouter](https://openrouter.ai) as your provider and pick the [`Free Models Router`](https://openrouter.ai/openrouter/free). No credit card.

Keep it updated:

```bash
jazz update
```

---

## What it is

- **Workflows.** Markdown files with frontmatter (`schedule`, `agent`, `autoApprove`, `catchUpOnStartup`). Run with `jazz workflow run <name>`, schedule with `jazz workflow schedule <name>`. Backed by `launchd` on macOS and `cron` on Linux. Catch-up replay if a scheduled run was missed. → [docs/concepts/workflows.md](docs/concepts/workflows.md)
- **Auto-approve tiers.** `false` (always ask), `read-only`, `low-risk` (+ archive email, calendar events), `high-risk` (+ file writes, shell, git push). Per-workflow, per-run.
- **CI surface.** `jazz --output raw workflow run <name> --auto-approve` is the CI-friendly invocation. `/jazz` comment trigger and `@jazz` mention trigger live in [`.github/workflows/jazz.yml`](.github/workflows/jazz.yml).
- **Personas with tool profiles.** Built-ins: `default`, `coder`, `researcher`. The `researcher` persona denies `write_file`, `edit_file`, `execute_command`, all `git_*` mutating tools — read-only at the schema level. Custom personas live in `~/.jazz/personas/`. → [docs/concepts/personas.md](docs/concepts/personas.md)
- **MCP.** Both stdio and Streamable HTTP transports. Subprocess env is sanitized. Tool schemas are normalized to Zod. → `jazz mcp add` / [docs/concepts/skills.md](docs/concepts/skills.md)
- **Skills.** 20+ built-in (code review, deep research, email, calendar, PR descriptions, Obsidian, browser, ...). Follows the [`.agents`](https://agentskills.io) convention so any community skill works. Drop into `~/.jazz/skills/` (global) or `./skills/` (project). → [docs/concepts/skills.md](docs/concepts/skills.md)
- **14 LLM providers** via the Vercel AI SDK: OpenAI, Anthropic, Google, Mistral, xAI, DeepSeek, Groq, Cerebras, Fireworks, TogetherAI, Moonshot AI, Alibaba, Ollama, OpenRouter. Switch mid-conversation with `/model`.
- **Effect-TS** under the hood. Typed errors, layered services, no silent failures.
- **You stay in control.** Reads/searches/web requests run freely. Writes, shell, git mutations, sends — all gated by approval (or by an explicit `autoApprove` tier you set). Every action is logged. OAuth2 for Gmail, API keys in config.

### Command reference

| Command | Description |
| --- | --- |
| `jazz` | Start chatting (interactive agent selection) |
| `jazz agent create` / `list` / `chat <name>` | Manage agents |
| `jazz workflow list` / `run <name>` / `schedule <name>` | Manage workflows |
| `jazz mcp add` / `list` | Manage MCP servers |
| `jazz persona ...` | Manage personas |
| `jazz auth gmail login` | OAuth Gmail |
| `jazz config show` | View configuration |
| `jazz update` | Update to latest |

In-chat slash commands: `/tools`, `/skills`, `/model`, `/mode`, `/cost`, `/context`, `/compact`, `/switch`, `/workflows`, `/help`.

---

## Workflows

A workflow is a Markdown file. Frontmatter declares schedule and autonomy; the body is the prompt.

```yaml
---
name: daily-standup-prep
description: Prep my standup notes
schedule: "0 9 * * 1-5"    # 9am, weekdays
agent: my-dev-agent
autoApprove: read-only
catchUpOnStartup: true
---
```

```markdown
Check my git activity from yesterday across ~/projects/.
Summarize what I worked on, PRs opened or reviewed,
and blockers I mentioned in commit messages.
Format as bullet points for Slack.
```

```bash
jazz workflow schedule daily-standup-prep
```

Built-in workflows ship in the repo: `email-cleanup`, `tech-digest`, `weather-briefing`, `market-analysis`. Use them, fork them, or write your own. → [docs/concepts/workflows.md](docs/concepts/workflows.md) · [docs/concepts/scheduling.md](docs/concepts/scheduling.md)

---

## CI/CD

Jazz is designed to run in your pipelines, not just on your laptop. The flags that matter:

- `--output raw` — plain text output, no Ink TUI.
- `--auto-approve` — combine with the workflow's `autoApprove` tier.
- `--agent <name>` — pin an agent so CI runs are reproducible.

This repo dogfoods it. Two automations live in [`.github/jazz/`](.github/jazz/):

- **Code review** on every PR — inline comments on specific lines.
- **PR assistant** — comment `/jazz <request>` to ask Jazz to do something on the PR. Bare `/jazz` defaults to a review pass.
- **Release notes** — generated from commits since the last tag and posted to the GitHub Release.

Drop the same pattern into your repo:

```yaml
name: AI Code Review
on: pull_request
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: npm install -g jazz-ai
      - run: jazz --output raw workflow run my-review --auto-approve
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

---

## How Jazz compares

Honest positioning. Pick the tool that fits the job.

| | Jazz | Claude Code / Cursor CLI / Aider |
| --- | --- | --- |
| Synchronous pair-programming, in-IDE diff editing | OK | **Better.** That's their core focus. |
| Composer-style multi-file edits with rich review UI | OK | **Better.** |
| Scheduled headless workflows (cron/launchd) with catch-up replay | **First-class.** | Not really a thing. |
| Auto-approve risk tiers (`read-only` / `low-risk` / `high-risk`) | Yes | No equivalent. |
| Drop-in CI runner with `/jazz` PR trigger and `--output raw` | Yes | Possible but not the design center. |
| MCP across stdio **and** Streamable HTTP | Yes | Varies. |
| LLM provider count | 14 (incl. local Ollama) | Usually 1–3. |

If you want an agent for **synchronous coding inside an editor**, Cursor or Claude Code will probably feel better. If you want an agent that runs on a schedule, reviews your PRs in CI, and chains MCP tools across services without hand-holding — that's where Jazz is built to live.

---

## Status

- **Version:** see [npm](https://www.npmjs.com/package/jazz-ai). Pre-1.0; expect breaking changes.
- **Roadmap and known gaps:** [`TODO.md`](TODO.md).
- **Discord:** [join the community](https://discord.gg/yBDbS2NZju).
- **Discussions:** [GitHub Discussions](https://github.com/lvndry/jazz/discussions).
- **Issues:** [report a bug](https://github.com/lvndry/jazz/issues).
- **Docs:** [`docs/README.md`](docs/README.md) · [Tools](docs/reference/tools.md) · [Integrations](docs/integrations/index.md) · [Examples](examples/).

---

## Contributing

Bug fixes, docs, tests, features, ideas — all welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT — see [`LICENSE`](LICENSE).

---

<div align="center">

```bash
npm install -g jazz-ai && jazz
```

[Back to top](#jazz-)

</div>

---

## Reviewer notes

**Claims verified against code:**

- `/jazz` PR trigger and `@jazz` assistant — confirmed in [`.github/workflows/jazz.yml`](.github/workflows/jazz.yml). The slash-command regex `/^\/jazz(?!-review)(?:\s*[:,-])?\s*([\s\S]*)/i` lives at the top of the resolve job. Recent commits 3b9d4a5 and 3fe3735 add/polish it.
- Auto-approve tiers — confirmed in `src/core/workflows/workflow-service.ts` (`parseAutoApprove`, accepts `read-only` / `low-risk` / `high-risk` / boolean). Tested in `workflow-service.test.ts`.
- Catch-up replay — confirmed: `promptInteractiveCatchUp` in `src/cli/catch-up-prompt.ts`, called from `src/app-layer.ts`. Core logic in `src/core/workflows/catch-up.ts` (`getCatchUpCandidates`, `runCatchUpForWorkflows`, `decideCatchUp`). Frontmatter field `catchUpOnStartup`.
- MCP transports — confirmed `StdioClientTransport` and `StreamableHTTPClientTransport` both used in `src/services/mcp/mcp-server-manager.ts`. Env sanitization via `createSanitizedEnv` on the stdio path.
- Personas with tool profiles + researcher read-only — confirmed: `personas/researcher/persona.md` has `tools.deny` covering `write_file`, `edit_file`, `execute_command`, all `git_*` mutators. Built-ins listed in `src/services/persona-service.ts`: `default`, `coder`, `researcher` (and internal `summarizer`).
- launchd / cron — confirmed in `src/core/workflows/scheduler-service.ts` (`getSchedulerType: () => "launchd" | "cron" | "unsupported"`).
- Provider count — counted 13 `@ai-sdk/*` deps + `@openrouter/ai-sdk-provider` = 14 explicitly wired providers. (Original README also lists Ollama; Ollama is reachable via the OpenAI-compatible endpoint, so I counted it inside the 14 — flag if you want a different framing.)

**Removed from the original README and why:**

- "Your terminal. Your agent. Your rules." tagline and the "not a chatbot, not a wrapper" paragraph — generic positioning that competes head-on with every other CLI agent. Replaced with the scheduling/CI angle.
- "The sky is the limit. Start automating." closing line — vague.
- Long "Real examples" list (review commits / find TODOs / refactor / generate PR description) — these are table stakes for any coding agent and don't differentiate. Trimmed to the three scenarios where Jazz actually wins.
- "Built to be reliable" Effect-TS paragraph — kept the Effect mention as one bullet, dropped the standalone section. Implementation detail, not a user-facing differentiator.
- "You Stay in Control" section as a standalone block — folded into the bullet list under "What it is" to save lines.
- Long workflow table (`email-cleanup` / `tech-digest` / `weather-briefing` / `market-analysis`) — kept as a one-liner in the Workflows section. The visual table didn't earn its space.
- Full command reference table was preserved but condensed.

**Unsure / want maintainer input:**

1. **Provider count of 14.** I included Ollama inside the count via OpenRouter / OpenAI-compatible reachability, but there's no dedicated `@ai-sdk/ollama` dep in `package.json`. If Ollama is wired through a different path I missed, adjust. Original README's claim of 12+ providers is also fine to keep.
2. **`/jazz` vs `@jazz`.** The recent commit messages say "/jazz PR trigger" (3b9d4a5) and the workflow regex matches `/jazz`. The previous README copy said `@jazz <request>`. I went with `/jazz` everywhere since that's what the regex enforces. Confirm if `@jazz` is still supported as an alias.
3. **Comparison table tone.** I tried to be honest without trashing competitors. If "OK" vs "Better" feels too blunt or too soft, adjust. The principle: name where Jazz loses (in-IDE editing UX) before naming where it wins (scheduling, CI, MCP breadth).
4. **Pre-1.0 framing under Status.** Version is 0.9.16 in `package.json`. Saying "expect breaking changes" matches AGENTS.md's "don't fear breaking changes" stance, but you may want softer language for the README.
5. **Catch-up TTY caveat.** `promptInteractiveCatchUp` only runs in TTY mode. I described it as "prompts to catch up the missed run" without mentioning that scripted/CI invocations skip the prompt. If you want that nuance front-and-center, add it to the inbox-triage scenario.
6. **Demo GIF.** Kept `assets/jazz_demo_800.gif` as instructed. If the GIF still shows the old "your terminal, your agent, your rules" framing, the new positioning will feel inconsistent until the GIF is re-shot.
7. **Length.** Final file is ~245 lines (vs 331 in the current README), inside the 200–280 target.
