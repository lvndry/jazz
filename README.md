# Jazz 🎷

[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Discord](https://img.shields.io/badge/chat-discord-5865F2.svg)](https://discord.gg/yBDbS2NZju)
[![npm version](https://img.shields.io/npm/v/jazz-ai.svg)](https://www.npmjs.com/package/jazz-ai)

> **Your AI agent that actually _does_ things**

Jazz is a powerful CLI that lets you create autonomous AI agents with real-world capabilities.
Instead of just chatting, your agents can read emails, manage git repositories, execute commands,
search the web, and orchestrate complex workflows—all through natural conversation.

## What Makes Jazz Different?

Traditional AI assistants can chat and suggest solutions, but you still have to do the work
yourself. Jazz agents go beyond conversation—they **actually execute tasks** in the real world.

**The difference in practice:**

- **Traditional AI**: "Here's how you could check your email..." → You still need to open Gmail
  yourself
- **Jazz agents**: "I'll check your email" → Agent reads your inbox, summarizes messages, and takes
  action

Jazz agents have real capabilities: they can read your emails, commit code to git, execute shell
commands, search the web, and orchestrate complex workflows—all through natural conversation, with
your approval for sensitive operations.

### Real Capabilities, Real Results

- 📧 **Email Automation** - Read, search, label, draft, and manage your Gmail inbox
- 🔧 **Git Operations** - Check status, commit changes, push code, manage branches
- 🌐 **Web Research** - Search the web and get current information via Linkup
- 💻 **Shell Commands** - Execute system commands with security safeguards
- 📁 **File Operations** - Read, write, search, and manage files intelligently
- 🔗 **HTTP Requests** - Call APIs and integrate with external services

### Built for Trust

- **User Approval System** - Dangerous operations require explicit confirmation
- **Security-First** - Command validation, process isolation, audit logging
- **Multi-LLM Support** - OpenAI, Anthropic, Google, Mistral, xAI, DeepSeek, Ollama
- **Type-Safe** - 100% TypeScript with Effect-TS for reliability

## Getting started

Let's get you up and running with your first Jazz agent in 3 simple steps!

### Step 1: Install Jazz

```bash
# Using npm
npm install -g jazz-ai

# Using bun
bun add -g jazz-ai

# Using pnpm
pnpm add -g jazz-ai

# Using yarn
yarn global add jazz-ai
```

### Step 2: Configure Your API Key

Jazz needs an API key from an LLM provider to power your agents. Let's set one up:

```bash
jazz config set llm
```

**Tip:** You can view your current configuration anytime with:

```bash
jazz config show
```

### Step 3: Create Your First Agent

Now let's create an agent! The interactive wizard will guide you through the process:

```bash
jazz agent create
```

```bash
$ jazz agent create
? What would you like to name your agent? my-assistant
? What should this agent do? Help me with daily tasks and file management
? Select LLM provider: OpenAI
? Select model: gpt-4o
? Select tools: (Use arrow keys and space to select)
  ◉ File System
  ◯ Git
  ◉ Shell
  ◯ Gmail
  ◯ Web Search
  ◯ HTTP
```

### Step 4: Start Chatting!

Your agent is ready! Start a conversation:

```bash
# Chat with your agent by name
jazz agent chat my-assistant
```

## Configuration

Jazz stores your settings and API keys in a JSON configuration file. You can manage your configuration using the CLI or by editing the file directly.

### Managing Configuration (Recommended)

Use the `jazz config` commands to easily manage your settings:

### Configuration File Location

Jazz looks for configuration in this order:

1. `JAZZ_CONFIG_PATH` environment variable
2. `./jazz.config.json` (current directory - mostly used in dev)
3. `~/.jazz/config.json` (home directory - **default**)

### Manual Configuration (Advanced)

If you prefer to edit the configuration file directly, create or edit `~/.jazz/config.json`:

```json
{
  "llm": {
    "openai": {
      "api_key": "sk-..."
    }
  },
  "google": {
    "clientId": "your-client-id.apps.googleusercontent.com",
    "clientSecret": "your-client-secret"
  },
  "linkup": {
    "api_key": "your-linkup-api-key"
  }
}
```

Complete config example [here](./examples)

See [docs/integrations.md](docs/integrations.md) for detailed setup instructions.

## Real-World Examples

### Git Assistant

```bash
$ jazz agent chat git-helper

You: What files have changed?
Agent: [Runs git status, shows modified files]

You: Commit these changes with a good message
Agent: [Analyzes diff, suggests commit message]
       About to commit with: "feat: add user authentication flow"
You: yes
Agent: ✓ Committed! Hash: abc123f
```

### Research and Report

```bash
$ jazz agent chat web-searcher

You: Search for the latest TypeScript 5.5 features and summarize them
Agent: [Searches web, analyzes results]
       TypeScript 5.5 introduces:
       - Inferred type predicates
       - Control flow narrowing improvements
       - [detailed summary with sources]
```

**Want more examples?** Check out our comprehensive [Examples & Use Cases](docs/examples.md) guide
featuring:

- 📧 Email management workflows
- 🔧 Git history cleanup and branch management
- 🚀 Automated project setup and cloning
- 🔍 Code analysis and refactoring
- 🔒 Security audits and dependency updates
- 📊 Repository analytics and reports
- 🌐 Web research and documentation generation
- 🤖 Advanced multi-step workflows

## CLI Commands

### Agent Management

```bash
jazz agent create              # Create new agent (interactive)
jazz agent list               # List all agents
jazz agent chat <id|name>     # Start conversation
jazz agent edit <id>          # Edit agent configuration
jazz agent get <id>           # View agent details
jazz agent delete <id>        # Remove agent
```

### Configuration Management

```bash
jazz config set <key>.        # Set a configuration value
jazz config get <key>         # Get a configuration value
jazz config list              # View all configuration
```

**Examples:**

```bash
jazz config set llm.openai.api_key sk-...
jazz config set google.clientId your-client-id
jazz config get llm.openai.api_key
```

### Authentication

```bash
jazz auth gmail login         # Connect Gmail account
jazz auth gmail status        # Check connection status
jazz auth gmail logout        # Disconnect account
```

### Other Commands

```bash
jazz update                   # Update to latest version
jazz update --check           # Check for updates only
jazz --version                # Show current version
```

### Options

```bash
--verbose, -v                 # Detailed logging
--debug                       # Debug mode
--config <path>               # Custom config file
```

## Agent Capabilities

Jazz agents can combine multiple tools to accomplish complex tasks:

| Category        | Tools    | Capabilities                                                                             |
| --------------- | -------- | ---------------------------------------------------------------------------------------- |
| **Gmail**       | 16 tools | List, search, read, send, label management, batch operations, trash/delete with approval |
| **Git**         | 9 tools  | Status, log, diff, branch, add, commit, push, pull, checkout with approval               |
| **File System** | 15 tools | Navigate, read, write, search, grep, find, stat, mkdir, rm with approval                 |
| **Shell**       | 2 tools  | Execute commands with security validation and approval                                   |
| **Web**         | 1 tool   | Search via Linkup with deep/standard modes                                               |
| **HTTP**        | 1 tool   | Make HTTP requests to APIs                                                               |

## Documentation

- **[Docs](docs/README.md)** - Complete documentation overview
- **[Getting Started](docs/getting-started.md)** - Installation, setup, and first agent
- **[Examples & Use Cases](docs/examples.md)** - Real-world workflows and inspiring examples
- **[Tools Reference](docs/tools-reference.md)** - Complete guide to all 44 tools
- **[CLI Reference](docs/cli-reference.md)** - Command-line interface documentation
- **[Integrations](docs/integrations.md)** - Set up Gmail, Linkup, and LLM providers
- **[Security Guide](docs/security.md)** - Security model and best practices
- **[Explorations](docs/exploration/README.md)** - Advanced patterns and future features

## Contributing

We welcome contributions! Jazz is actively developed and there are many opportunities to help:

### Ways to Contribute

- 🐛 **Fix Bugs** - Check out [open issues](https://github.com/lvndry/jazz/issues)
- ✨ **Add Features** - See [TODO.md](./TODO.md) for planned features
- 📖 **Improve Docs** - Help make Jazz easier to use
- 🧪 **Write Tests** - Increase test coverage
- 💡 **Share Ideas** - Join [Discussions](https://github.com/lvndry/jazz/discussions) to share ideas
  and move conversations forward
- 🔬 **Explore Advanced Topics** - Check out the [exploration folder](docs/exploration/README.md)
  for future features and research

### Quick Start for Contributors

1. Fork the repository
2. Check [TODO.md](./TODO.md) or [GitHub issues](https://github.com/lvndry/jazz/issues) for tasks
   ready to be tackled
3. Read [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines
4. Submit a PR!

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support & Community

- 📖 [Documentation](docs/)
- 💬 [Discord Community](https://discord.gg/yBDbS2NZju)
- 🐛 [Issue Tracker](https://github.com/lvndry/jazz/issues)
- 💡 [Discussions](https://github.com/lvndry/jazz/discussions)

## Give some love

If Jazz helps you automate your workflows, consider giving it a ⭐️ on GitHub!

---

**Built with ❤️ by [lvndry](https://github.com/lvndry)**

_Jazz - Because AI should do more than just chat_
