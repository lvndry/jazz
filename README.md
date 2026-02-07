<div align="center">

# Jazz 🎷

[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue.svg)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![npm version](https://img.shields.io/npm/v/jazz-ai.svg)](https://www.npmjs.com/package/jazz-ai)

### Your AI agent that actually does things.

<!-- TODO: Add a GIF or screenshot showing Jazz in action -->

<!-- ![Jazz Demo](https://via.placeholder.com/800x400?text=Jazz+Demo+GIF+Coming+Soon) -->

</div>

---

**Why people love Jazz:**

- ✅ **60+ builtin tools** — Git, Gmail, filesystem, shell, HTTP, PDF, and more
- ✅ **MCP support** — Connect to Notion, Slack, MongoDB, GitHub, PostgreSQL, and hundreds more
- ✅ **Scheduled grooves** — Automate recurring tasks with cron-based scheduling
- ✅ **Agent Skills** — Teach agents complex, multi-step procedures
- ✅ **Any LLM provider** — OpenAI, Anthropic, Google, Mistral, Ollama, OpenRouter, and more
- ✅ **Safety first** — Every high-risk action requires your explicit approval

---

## 📑 Table of Contents

- [Why Jazz?](#why-jazz)
- [Quick Start](#-quick-start)
- [Usage Highlights](#-usage-highlights)
- [Built for Production](#️-built-for-production)
- [What's Next](#️-whats-next)
- [Documentation & Community](#-documentation--community)
- [Contributing](#-contributing)

---

## Why Jazz?

### 🤖 Not Just Chat, Real Action

**Jazz doesn't just talk about work, it does the work.**

Ask Jazz to `analyze yesterday's unread emails and archive newsletters`, it connects to Gmail, reads your inbox, categorizes messages, and archives them. Ask it to `commit my changes with a good message`, it runs `git diff`, analyzes your changes, generates a semantic commit message, and commits the code. Ask it to `find all TODO comments in the codebase`, it searches your files, extracts context, and organizes them by priority.

This isn't a chatbot, it's an autonomous agent that executes multi-step workflows, makes decisions, and gets things done.

### 🎯 Purpose, Built for Workflows

Jazz is designed from the ground up for autonomous agents that handle multi-step, real-world tasks with contextual awareness.

### 🛠️ 60+ Tools, Ready to Use

Git, Gmail, filesystem, shell, web search, HTTP, PDF, and more. Just create an agent and start automating. See [`docs/integrations.md`](docs/integrations.md) for setup instructions.

**Plus MCP Support**: Connect to any [Model Context Protocol](https://modelcontextprotocol.io/) server — Notion, MongoDB, GitHub, Slack, PostgreSQL, and hundreds more. Your agents can use any MCP-compatible tool.

### 🧠 Agent Skills, Built for Complex Workflows

**Jazz agents can learn and follow specialized procedures.**

[Agent Skills](https://agentskills.io/home) provides a way to give agents detailed, multi-step instructions for specific domains without overloading their context window.

- **Progressive Disclosure**: Agents only load the instructions they need when they need them.
- **Smart Discovery**: Agents automatically "see" available skills and decide which one to use based on your request.
- **Local & Global**: Skills can be stored globally in `~/.jazz` or locally in your project.
- **Interactive Inspection**: Use the `/skills` command during chat to browse and read available skills yourself.

### ⏰ Grooves, Automated & Scheduled

**Jazz grooves let you automate recurring tasks and schedule them to run automatically.**

Create `GROOVE.md` files that describe what the agent should do, then schedule them to run hourly, daily, or on any cron schedule:

- **Scheduled Execution**: Run grooves on a cron schedule using your system scheduler (launchd on macOS, cron on Linux)
- **Auto-Approve Policies**: Set risk-based auto-approval (`read-only`, `low-risk`, `high-risk`) for unattended execution
- **Agent Selection**: Choose which agent runs each groove
- **Run History**: Track execution history, logs, and errors
- **Catch-Up on Startup**: Optionally run missed grooves when Jazz starts
- **Built-in Examples**: Email cleanup, weather briefings, tech digests, market analysis, and more

Example: Schedule a daily market analysis at 6 AM:

```bash
jazz groove schedule market-analysis
```

### 🧠 Multi LLM, Model Agnostic

Switch between OpenAI, Anthropic, Google, Mistral, xAI, DeepSeek, Ollama, Openrouter and more, even mid-conversation. Your agents aren't locked to one provider.

### 🔒 Safety First

**Every dangerous action requires your explicit approval.**

- **Requires confirmation**: Git commits, file changes, sending emails, shell commands, API requests
- **Executes automatically**: Reading files, searching, analyzing code, viewing data
- **Secure credentials**: OAuth2 authentication, never logged or exposed
- **Full audit trail**: Complete logs of every agent action for transparency and debugging

You stay in control. Jazz won't delete files, push code, or send emails without showing you exactly what it will do and waiting for your "yes".

---

## 🚀 Quick Start

### 1. Install the CLI

```bash
# npm
npm install -g jazz-ai

# bun
bun add -g jazz-ai

# pnpm
pnpm add -g jazz-ai

# yarn
yarn global add jazz-ai
```

### 2. Chat With Your Agent

Simply run `jazz` to start a chat with your agent:

```bash
jazz
```

> [!TIP]
> **Get started for free!** You can use Jazz for free by selecting **OpenRouter** as your provider and choosing [`Free Models Router`](https://openrouter.ai/openrouter/free).

### 3. Update Jazz

Keep Jazz up to date with the latest features and improvements:

```bash
jazz update
```

---

## 📚 Usage Highlights

| Command                       | Description                            |
| ----------------------------- | -------------------------------------- |
| `jazz agent create`           | Create a new agent                     |
| `jazz agent chat <name>`      | Start chatting with an agent           |
| `jazz agent list`             | List all your agents                   |
| `jazz agent edit <id>`        | Edit an existing agent                 |
| `jazz groove list`            | List all available grooves             |
| `jazz groove run <name>`      | Run a groove manually                  |
| `jazz groove schedule <name>` | Schedule a groove to run automatically |
| `jazz groove scheduled`       | Show scheduled grooves                 |
| `jazz config show`            | View your configuration                |
| `jazz auth gmail login`       | Authenticate with Google (Gmail)       |
| `jazz update`                 | Update Jazz to the latest version      |

---

## 🏗️ Built for Production

Jazz is built with **100% TypeScript** and **Effect-TS** for production-grade reliability:

- **Type-Safe by Design**: Explicit error types and recovery paths ensure bulletproof error handling
- **Security-First**: All state-changing operations require explicit approval; credentials stored securely, never logged
- **Input Validation**: All external inputs validated and sanitized before processing
- **Contextual Awareness**: Agents maintain working directory and conversation context across multi-step workflows
- **Intelligent Orchestration**: Smart sequencing of tools with graceful error recovery and retry logic
- **Complete Auditability**: Full logs of all agent actions for transparency and debugging

---

## 🗺️ What's Next

Jazz is actively developed with exciting features coming.
See [TODO.md](TODO.md) for the full roadmap and [docs/exploration/](docs/exploration/) for research on future features.

---

## 📖 Documentation & Community

**Documentation:**

- **Full Documentation** — [`docs/README.md`](docs/README.md)
- **Examples** — [`examples/`](examples/)
- **Tools Reference** — [`docs/tools-reference.md`](docs/tools-reference.md)
- **Exploration** — [`docs/exploration/`](docs/exploration/) for future features and research

**Community:**

- **Discord Community** — [Join us on Discord](https://discord.gg/yBDbS2NZju)
- **GitHub Discussions** — [Discuss ideas](https://github.com/lvndry/jazz/discussions)
- **Issue Tracker** — [File issues](https://github.com/lvndry/jazz/issues)

---

## 🤝 Contributing

We welcome contributions of all kinds: bug fixes, docs, tests, and features.

- See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the contributor guide and PR process

---

## 📄 License

MIT — see [`LICENSE`](LICENSE).

---

<div align="center">

⭐ If Jazz helps you automate your work, please give the project a star on GitHub, it helps others find it!

[⬆ Back to top](#jazz-)

</div>
