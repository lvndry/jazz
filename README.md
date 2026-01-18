<div align="center">

# Jazz 🎷

[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue.svg)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![npm version](https://img.shields.io/npm/v/jazz-ai.svg)](https://www.npmjs.com/package/jazz-ai)

### Your AI agent that actually does things.

</div>

---

## 📑 Table of Contents

- [Why Jazz?](#why-jazz)
- [Quick Start](#-quick-start)
- [Usage Highlights](#-usage-highlights)
- [See Jazz in Action](#see-jazz-in-action)
- [Built for Production](#️-built-for-production)
- [What's Next](#️-whats-next)
- [Documentation & Community](#-documentation--community)
- [Contributing](#-contributing)
- [License](#-license)

---

## Why Jazz?

### 🤖 Not Just Chat, Real Action

**Jazz doesn't just talk about work, it does the work.**

Ask Jazz to `analyze yesterday's unread emails and archive newsletters`, it connects to Gmail, reads your inbox, categorizes messages, and archives them. Ask it to `commit my changes with a good message`, it runs `git diff`, analyzes your changes, generates a semantic commit message, and commits the code. Ask it to `find all TODO comments in the codebase`, it searches your files, extracts context, and organizes them by priority.

This isn't a chatbot, it's an autonomous agent that executes multi-step workflows, makes decisions, and gets things done.

### 🎯 Purpose, Built for Workflows

Jazz is designed from the ground up for autonomous agents that handle multi-step, real-world tasks with contextual awareness.

### 🛠️ 44+ Tools, Ready to Use

Git, Gmail, filesystem, shell, web search, HTTP, PDF, and more. Just create an agent and start automating. See [`docs/integrations.md`](docs/integrations.md) for setup instructions.

**Plus MCP Support**: Connect to any [Model Context Protocol](https://modelcontextprotocol.io/) server — Notion, MongoDB, GitHub, Slack, PostgreSQL, and hundreds more. Your agents can use any MCP-compatible tool.

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

### 2. Create Your First Agent

```bash
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

## See Jazz in Action

### Example 1: Email Triage

```bash
$ jazz agent chat email-assistant

You: Summarize unread emails from yesterday and organize them

Agent: 📧 Found 23 unread emails from yesterday

📊 Summary:
- Work: 12 emails (5 from team, 4 PRs, 3 meetings)
- Newsletters: 8 emails
- Social: 3 emails

I can:
1. Archive all newsletters
2. Label work emails by sender
3. Draft replies for urgent items

What would you like me to do?

You: Archive newsletters and label work emails

Agent: ⚠️ About to:
- Archive 8 newsletter emails
- Add labels to 12 work emails

Proceed? (yes/no): yes

Agent: ✓ Done! Inbox organized.
```

### Example 2: Git Assistant

```bash
$ jazz agent chat git-helper

You: What changed in my code?

Agent: [Running git status...]

Found 3 modified files:
1. src/auth/jwt.ts - Token refresh logic added
2. src/middleware/auth.ts - New authentication middleware
3. tests/auth.test.ts - 12 new test cases

Summary:
- Added automatic token refresh before expiration
- Implemented refresh token rotation
- Added comprehensive test coverage

Suggested commit message:
"feat: implement JWT token refresh with rotation

- Add automatic refresh 5min before expiration
- Implement single-use refresh token rotation
- Add Redis caching for token blacklist
- Add 12 new tests covering refresh flow"

Should I commit these changes? (yes/no):

You: yes

Agent: ✓ Committed successfully
```

### Example 3: Code Analyzer - Bug Analysis

```bash
$ jazz agent chat code-analyzer

You: I'm getting an error "Cannot read property 'id' of undefined" in src/api/users.ts. Help me analyze this bug.

Agent: [Reading src/api/users.ts...]
       [Analyzing error context...]

       Found the issue at line 45:

       const user = await getUserById(userId);
       return user.id;  // ← Error: user might be undefined

       Analysis:
       - The `getUserById` function can return `undefined` if user not found
       - Line 45 accesses `user.id` without checking if user exists
       - This causes the error when a non-existent user ID is requested

       Suggested fix:
       1. Add null check before accessing user.id
       2. Return appropriate error response for not found cases
       3. Consider updating getUserById to throw an error instead

       Should I show you the fix?

You: yes, apply the fix

Agent: [Applying fix...]

       Updated code:
       const user = await getUserById(userId);
       if (!user) {
         throw new NotFoundError(`User ${userId} not found`);
       }
       return user.id;

       ✓ Fix applied
       ✓ Added error handling
```

### Example 4: PDF Summary

```bash
$ jazz agent chat pdf-reader

You: Read the PDF at ~/Documents/bitcoin.pdf and make a summary

Agent: [Reading PDF file...]
       ✓ Successfully read ~/Documents/bitcoin.pdf

       [Analyzing content...]
       Document: "Bitcoin: A Peer-to-Peer Electronic Cash System"
       Pages: 9

       # Summary

       ## Overview
       This paper introduces Bitcoin, a decentralized digital currency system
       that enables peer-to-peer electronic transactions without requiring a
       trusted third party.

       ## Key Topics

       ### 1. The Double-Spending Problem
       - Traditional digital cash requires a trusted central authority
       - Bitcoin solves this through cryptographic proof instead of trust

       ### 2. Network Architecture
       - Peer-to-peer network using proof-of-work
       - Transactions are broadcast to all nodes
       - Nodes accept the longest proof-of-work chain as valid

       ### 3. Proof-of-Work Mechanism
       - Nodes compete to solve computational puzzles
       - Difficulty adjusts to maintain ~10 minute block times
       - Network is resistant to attacks as long as honest nodes control
         majority of CPU power

       ## Key Findings
       - Eliminates need for financial institutions as intermediaries
       - Transactions are irreversible once confirmed
       - Privacy maintained through public keys (pseudonymous, not anonymous)

       ✓ Summary complete
```

**Want more examples?** See the [`examples/`](examples/) folder for additional use cases.

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
