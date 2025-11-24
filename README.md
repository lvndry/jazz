<div align="center">

# Jazz 🎷

[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue.svg)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![npm version](https://img.shields.io/npm/v/jazz-ai.svg)](https://www.npmjs.com/package/jazz-ai)

### Your AI agent that actually does things.

</div>

---

## What Jazz Gives You

Turn plain language into **safe, auditable actions**. Jazz agents read email, run git commands, edit files, call APIs, research the web, and orchestrate multi-step workflows.

**In short:** Jazz can do literally everything an agent should do for real work and save you the manual steps.

<details>
<summary><strong>Expand to see what Jazz can do</strong></summary>

- **Email Management** — Summarize and triage your inbox, draft replies, and label messages
- **Git Operations** — Inspect repos, propose and create commits, push changes when you approve
- **Web Research** — Search the web for up-to-date answers and synthesize sources into a brief
- **Shell & Files** — Run shell commands and make targeted file edits after showing a preview
- **API Integration** — Call remote APIs (HTTP) and combine results into reports or automation flows

</details>

---

## 🚀 Quick Start — Get Productive in Minutes

### 1. Install the CLI

```bash
# npm
npm install -g jazz-ai

# pnpm
pnpm add -g jazz-ai

# bun
bun add -g jazz-ai

# yarn
yarn global add jazz-ai
```

### 2. Create Your First Agent

No prior config required — the wizard will guide you:

```bash
# Run the interactive wizard — if an API key is missing the wizard will ask for it
jazz agent create
```

The wizard walks you through:

- Name and description
- Provider/model selection
- Tool selection

### 3. Chat With Your Agent

```bash
jazz agent list
jazz agent chat <agent-name>
```

Agents stream responses, call tools, and ask for approval for any actions that change state.

---

## 📚 Usage Highlights

| Command                  | Description                  |
| ------------------------ | ---------------------------- |
| `jazz agent create`      | Create a new agent           |
| `jazz agent chat <name>` | Start chatting with an agent |
| `jazz agent list`        | List all your agents         |
| `jazz agent edit <id>`   | Edit an existing agent       |
| `jazz config show`       | View your configuration      |
| `jazz auth gmail login`  | Authenticate with Gmail      |

---

## 🎯 What You Can Expect

### Multi-Provider LLM Support

OpenAI • Anthropic • Google • Ollama • Openrouter • And more...

### Safety & Auditability

Explicit approval workflow • Typed, auditable tools • Audit logs for transparency

### Rich Developer Experience

Streaming responses • Rich CLI rendering • Easy testing & mocking through Effect Layers

### Powerful Tools

Filesystem operations • Git integration • Gmail access • HTTP requests • Shell commands • Web search

---

## 💡 Real-World Examples

<details>
<summary><strong>Git Assistant</strong></summary>

Ask: _"what changed?"_

**Jazz will:**

1. Run `git status`
2. Summarize diffs
3. Suggest commit messages
4. Commit when you say "yes"

</details>

<details>
<summary><strong>Email Triage</strong></summary>

Ask: _"summarize unread messages from yesterday"_

**Jazz will:**

1. Read your unread messages
2. Provide summaries
3. Offer actions (draft reply, archive, label)

</details>

<details>
<summary><strong>Research & Report</strong></summary>

Ask: _"collect latest guides on TypeScript 5.5 and summarize sources"_

**Jazz will:**

1. Search the web
2. Aggregate information
3. Output a concise report with links

</details>

<details>
<summary><strong>Automated Project Onboarding</strong></summary>

Ask: _"Set up the project from github.com/user/awesome-app for local development"_

**Jazz will:**

1. Clone the repository to your preferred directory
2. Detect the tech stack (Node.js, Python, etc.)
3. Search for setup instructions in README/docs
4. Install dependencies (`npm install`, `pip install`, etc.)
5. Create `.env` file from `.env.example` and prompt for missing keys
6. Run initialization scripts if needed
7. Verify the setup by running tests
8. Summarize what was configured and next steps

</details>

<details>
<summary><strong>Dependency Security Audit</strong></summary>

Ask: _"Audit my dependencies for vulnerabilities and fix them"_

**Jazz will:**

1. Run security audit (`npm audit`, `poetry audit`, etc.)
2. Search CVE databases and changelogs for each vulnerability
3. Identify safe upgrade paths (major vs. patch versions)
4. Show you a summary with severity levels and fix options
5. Update `package.json`/`requirements.txt` with your approval
6. Run tests to verify nothing broke
7. Create a detailed commit message documenting the security fixes

</details>

---

## 📖 Documentation & Community

**Documentation:**

- **Full Documentation** — [`docs/README.md`](docs/README.md)
- **Getting Started & Examples** — [`docs/getting-started.md`](docs/getting-started.md), [`examples/`](examples/)
- **Tools Reference** — [`docs/tools-reference.md`](docs/tools-reference.md)
- **Exploration** — [`exploration/`](exploration/) for future features and ideas that require research

**Community:**

- **Discord Community** — [Join us on Discord](https://discord.gg/yBDbS2NZju)
- **GitHub Discussions** — [Discuss ideas](https://github.com/lvndry/jazz/discussions)
- **Issue Tracker** — [File issues](https://github.com/lvndry/jazz/issues)

---

## 🤝 Contributing

We welcome contributions of all kinds: bug fixes, docs, tests, and features.

- See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the contributor guide and PR process

---

## 🔒 Security & Safety

- Dangerous or irreversible operations require **explicit user approval**
- Audit logs available in `~/.jazz/logs/` for transparency

---

## 📄 License

MIT — see [`LICENSE`](LICENSE).

---

<div align="center">

⭐ If Jazz helps you automate your work, please give the project a star on GitHub — it helps others find it!

[⬆ Back to top](#jazz-)

</div>
