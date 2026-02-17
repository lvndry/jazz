<div align="center">

# Jazz 🎷

[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue.svg)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![npm version](https://img.shields.io/npm/v/jazz-ai.svg)](https://www.npmjs.com/package/jazz-ai)

### Your terminal. Your agent. Your rules.

![Jazz Demo](assets/jazz_demo_800.gif)

Jazz is an AI agent that lives in your terminal and actually does things.
Not a chatbot. Not a wrapper around an API. A personal assistant you control,
that reads your files, manages your git, searches the web, handles your email,
and automates the workflows you're tired of doing by hand.

[Quick Start](#-quick-start) · [What Can It Do?](#-what-can-it-do) · [Workflows](#-workflows-automate-everything) · [CI/CD](#-cicd-jazz-in-your-pipelines) · [Docs](docs/README.md) · [Discord](https://discord.gg/yBDbS2NZju)

</div>

---

## Why Jazz?

Because your terminal should be smarter than a blinking cursor.

Jazz is a personal assistant that lives where you already work. It can read your filesystem, manage your git repos, search the web, handle your email, run shell commands, talk to APIs -- and it does all of it autonomously, step by step, without you having to hold its hand. It's LLM provider agnostic, supports agent skills, and connects to anything through MCP.

Tell it to "analyze yesterday's unread emails and archive the newsletters" -- it connects to Gmail, reads your inbox, categorizes messages, and archives them. Tell it to "commit my changes with a good message" -- it runs `git diff`, reads the changes, writes a semantic commit message, and commits. Tell it to "find all security vulnerabilities in this codebase" -- it scans your files, analyzes patterns, and gives you a prioritized report.

You describe what you want. Jazz figures out how to do it.

---

## 🚀 Quick Start

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

> **Start using Jazz for free** -- choose [OpenRouter](https://openrouter.ai) as your provider and select the [`Free Models Router`](https://openrouter.ai/openrouter/free). No credit card, no commitment.

Keep it updated:

```bash
jazz update
```

---

## 🎯 What Can It Do?

### The short answer: almost anything you can describe.

Jazz understands your filesystem, your git history, your shell, HTTP APIs, the web, PDFs and it can connect to external services through MCP. But capabilities are just the foundation. What makes Jazz different is how it _combines_ them to solve your actual problems.

### Real examples, real workflows

**Development**

```
> review the last 5 commits and flag anything that looks risky
> find all TODO comments, group them by priority, and create a summary
> refactor this function to use async/await and update all callers
> generate a PR description from the current branch diff
```

**Email & Communication**

```
> check my unread emails, summarize anything important, archive the rest
> draft a reply to the latest email from Sarah about the project timeline
```

**Research & Analysis**

```
> research the latest developments in WebAssembly and write a 2-page summary
> compare React Server Components vs Astro islands architecture with pros and cons
> analyze this PDF report and extract the key financial metrics
```

**Research & Knowledge Management**

```
> do deep research on the Three-Body Problem and write it in my Obsidian vault
```

### LLM Provider Agnostic

Jazz doesn't lock you in. Use whichever model fits the task or switch mid-conversation. Run locally with Ollama, go through OpenRouter for access to hundreds of models, or plug in your own endpoint.

OpenAI, Anthropic, Google, Mistral, xAI, DeepSeek, Groq, Cerebras, Fireworks, TogetherAI, Ollama, OpenRouter, and more.

### MCP: Connect to Everything

Jazz speaks [Model Context Protocol](https://modelcontextprotocol.io/). One config block, and your agent can talk to any MCP-compatible service:

Simply run `jazz mcp add` add input the MCP configuration:

```json
{
  "mcpServers": {
    "notion": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.notion.com/mcp"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

### Skills: Extend Your Agent

Skills are packaged expertise your agent loads on demand—proven playbooks for complex tasks instead of winging it every time. Think deep research with multi-source verification, structured code review, meeting notes that follow your format, PR descriptions from your conventions. You get consistency and domain expertise without stuffing the context window.

Jazz ships with **20+ built-in skills**—code review, deep research, email, calendar, PR descriptions, documentation, browser automation, Obsidian, budgeting, and more. Add your own from the ecosystem: Jazz follows the [`.agents` convention](https://agentskills.io), so any skill works. Run `npx skills add` to browse and install, or drop a skill in `~/.jazz/skills/` (global) or `./skills/` (project-local). Use `/skills` in chat to browse what's available.

---

## ⏰ Workflows: Automate Everything

A workflow is a Markdown file that describes what your agent should do, when it should do it, and how much autonomy it gets. Schedule them with cron, run them headless, and let Jazz handle the boring parts of your day.

### Built-in Workflows

Jazz ships with workflows ready to go:

| Workflow             | Schedule      | What it does                                                      |
| -------------------- | ------------- | ----------------------------------------------------------------- |
| **email-cleanup**    | Hourly        | Archive newsletters, organize promotions, flag important messages |
| **tech-digest**      | Daily         | Scan AI/tech news sources and compile a personalized digest       |
| **weather-briefing** | Every morning | Weather forecast + outfit recommendations for your location       |
| **market-analysis**  | Daily         | Stock/crypto analysis with buy/sell signals                       |

### Create Your Own

Any task you do repeatedly can become a workflow. Write a `WORKFLOW.md`:

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
Summarize what I worked on, what PRs I opened or reviewed,
and any blockers I mentioned in commit messages.
Format it as bullet points I can paste into Slack.
```

Then schedule it:

```bash
jazz workflow schedule daily-standup-prep
```

Jazz uses `launchd` on macOS and `cron` on Linux. If your machine was asleep when a workflow was supposed to run, Jazz can catch up automatically on next launch.

### Auto-Approve Policies

Control how much autonomy each workflow gets:

| Policy      | What it auto-approves                       |
| ----------- | ------------------------------------------- |
| `false`     | Nothing -- always asks                      |
| `read-only` | Reading files, searching, web requests      |
| `low-risk`  | + archiving email, creating calendar events |
| `high-risk` | + file changes, shell commands, git push    |

---

## 🔁 We use Jazz to build Jazz.

Jazz isn't just a local tool. It runs in CI/CD pipelines with `--output raw` and `--auto-approve` flags, purpose-built for automation.

### Automated Code Review

Every pull request to Jazz gets reviewed by a Jazz agent. The [`jazz.yml`](.github/workflows/jazz.yml) workflow:

1. Installs `jazz-ai` in the CI runner
2. Runs a code review workflow against the PR diff
3. Posts **inline review comments** directly on the PR -- on specific lines, with context

```yaml
# .github/workflows/jazz.yml (simplified)
- name: Run Jazz code review
  run: jazz --output raw workflow run code-review --auto-approve --agent ci-reviewer
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

The review agent checks for correctness, security issues, TypeScript best practices, Effect-TS patterns, and performance concerns. Real reviews, on real code, every PR.

### Automated Release Notes

Every release gets its notes written by Jazz. The [`release.yml`](.github/workflows/release.yml) workflow:

1. Bumps the version and creates a git tag
2. Runs a Jazz agent to analyze all commits since the last release
3. Generates release notes grouped by feature area
4. Creates the GitHub Release with those notes

No more "what changed in this release?" -- Jazz reads the commits, understands the changes, and writes release notes that actually make sense.

### Run Jazz in Your Own Pipelines

```yaml
# Your .github/workflows/review.yml
name: AI Code Review
on: pull_request

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - run: npm install -g jazz-ai

      - name: Run review
        run: jazz --output raw workflow run my-review --auto-approve
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

See [`.github/jazz/`](.github/jazz/) for the full agent configs and workflow templates we use.

---

## 🔒 You Stay in Control

Jazz is powerful, but it never acts without your say-so.

**Requires approval:** File changes, git commits, shell commands, sending emails, API mutations
**Runs freely:** Reading files, searching, analyzing code, web lookups, viewing data

Every action is logged. You see exactly what Jazz wants to do before it does it. You can review, approve, deny, or modify. Full audit trail, always.

Credentials are stored securely (OAuth2 for Gmail, API keys in config). Nothing is logged or exposed.

---

## 📋 Command Reference

| Command                         | Description                                  |
| ------------------------------- | -------------------------------------------- |
| `jazz`                          | Start chatting (interactive agent selection) |
| `jazz agent create`             | Create a new agent                           |
| `jazz agent chat <name>`        | Chat with a specific agent                   |
| `jazz agent list`               | List all agents                              |
| `jazz workflow list`            | List available workflows                     |
| `jazz workflow run <name>`      | Run a workflow                               |
| `jazz workflow schedule <name>` | Schedule a workflow                          |
| `jazz mcp add`                  | Add an MCP server                            |
| `jazz mcp list`                 | List MCP servers                             |
| `jazz config show`              | View configuration                           |
| `jazz auth gmail login`         | Authenticate with Gmail                      |
| `jazz update`                   | Update to latest version                     |

**In-chat commands:** `/tools`, `/skills`, `/model`, `/mode`, `/cost`, `/context`, `/compact`, `/switch`, `/workflows`, and more. Type `/help` during chat.

---

## 🏗️ Built to Be Reliable

Jazz is 100% TypeScript with [Effect-TS](https://effect.website/) under the hood. That means every error has a recovery path, every side effect is tracked, and nothing silently fails.

It manages its own context window (auto-summarizes when things get long), delegates deep tasks to sub-agents, and gracefully recovers from timeouts and failures. You can throw complex, multi-step problems at it and trust that it won't fall apart halfway through.

---

## 📖 Documentation & Community

|                        |                                                                  |
| ---------------------- | ---------------------------------------------------------------- |
| **Full Documentation** | [`docs/README.md`](docs/README.md)                               |
| **Tools Reference**    | [`docs/tools-reference.md`](docs/tools-reference.md)             |
| **Integrations**       | [`docs/integrations.md`](docs/integrations.md)                   |
| **Examples** (20+)     | [`examples/`](examples/)                                         |
| **Research & Roadmap** | [`docs/exploration/`](docs/exploration/)                         |
| **Discord**            | [Join the community](https://discord.gg/yBDbS2NZju)              |
| **Discussions**        | [GitHub Discussions](https://github.com/lvndry/jazz/discussions) |
| **Issues**             | [Report a bug](https://github.com/lvndry/jazz/issues)            |

---

## 🤝 Contributing

We welcome contributions -- bug fixes, docs, tests, features, and ideas.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the contributor guide.

---

## 📄 License

MIT -- see [`LICENSE`](LICENSE).

---

<div align="center">

**The sky is the limit.** Start automating.

```bash
npm install -g jazz-ai && jazz
```

[Back to top](#jazz-)

</div>
