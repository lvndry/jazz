# Jazz Documentation

Complete documentation for Jazz - Your AI agent that actually does things.

## Architecture Highlights

- **Effect-TS Foundation** - Functional programming for bulletproof error handling
- **Type-Safe Everything** - Full TypeScript with strict mode
- **Modular Tool System** - Easy to extend with custom tools
- **Context-Aware** - Maintains working directory per conversation
- **Approval Workflows** - Two-phase execution for dangerous operations
- **Multi-Provider** - Switch LLM providers without changing agents

## 📚 Documentation Overview



1. **[Getting Started](getting-started.md)** - Install Jazz, create your first agent, and start chatting
   - Installation instructions
   - Configuration setup
   - First agent creation
   - Example conversations
   - Common workflows

2. **[Examples & Use Cases](examples.md)** - Real-world examples and inspiring workflows
   - Email management automation
   - Git operations and cleanup
   - Project setup automation
   - Code analysis and refactoring
   - Security audits
   - Advanced workflows

3. **[Integrations](integrations.md)** - Set up external services
   - LLM providers (OpenAI, Anthropic, Google, Mistral, xAI, DeepSeek, Ollama)
   - Gmail integration (OAuth setup)
   - Web search
   - Configuration examples

4. **[Security](security.md)** - Security model and best practices
   - Understanding risks
   - Security features
   - Approval system
   - Best practices
   - Incident response

5. **[Skills](skills.md)** - Skills: full feature capabilities
   - What skills are and why they matter
   - How discovery and progressive loading work
   - Built-in skills and creating your own
   - Where skills live (built-in, global, local)

## 🗺️ Navigation Guide

### By Task

**I want to...**

- **Get started quickly** → [Getting Started](getting-started.md)
- **See what's possible** → [Examples & Use Cases](examples.md)
- **Set up Gmail** → [Integrations > Gmail](integrations.md#gmail-integration)
- **Set up web search** → [Integrations > Linkup](integrations.md#linkup-web-search)
- **Configure LLM providers** → [Integrations > LLM Providers](integrations.md#llm-providers)
- **Understand security** → [Security Guide](security.md)
- **Learn what skills can do** → [Skills](skills.md)

### By Role

**For End Users:**

- [Getting Started](getting-started.md) - How to use Jazz
- [Examples & Use Cases](examples.md) - Real-world workflows
- [Tools Reference](tools-reference.md) - What your agents can do
- [Skills](skills.md) - Skills and workflows
- [Security](security.md) - Stay safe

**For Developers:**

- [Examples & Use Cases](examples.md) - Advanced automation patterns
- [FAQ](FAQ.md) - Common developer questions and answers
- [Architecture](ARCHITECTURE.md) - Code organization and conventions
- [Integrations](integrations.md) - API keys and setup
- [CLI Reference](cli-reference.md) - Command details
- [../CONTRIBUTING.md](../CONTRIBUTING.md) - Contributing guide
- [../TODO.md](../TODO.md) - Feature roadmap

## 📖 Reading Order

### Advanced Path

1. Start with [Getting Started](getting-started.md)
2. Explore [Examples & Use Cases](examples.md) for complex workflows
3. [Architecture](ARCHITECTURE.md) for code organization
4. [Integrations](integrations.md) for multi-provider setup
5. [Security](security.md) for advanced security practices

### Common Commands

```bash
# Agent Management
jazz agent create             # Create agent
jazz agent list               # List agents
jazz agent chat <name>        # Chat with agent

# Config
jazz config set llm           # configure an api key for a provider
jazz config show              # Show current config being used

# Authentication
jazz auth gmail login         # Connect Gmail

# Help
jazz --help                   # Show help
jazz agent --help             # Agent commands help
```

### Tool Categories

| Category        | Count | Key Features      |
| --------------- | ----- | ----------------- |
| Gmail           | 16    | Email automation  |
| Git             | 9     | Version control   |
| File Management | 15    | File operations   |
| Shell           | 2     | Command execution |
| Web Search      | 1     | Internet search   |
| HTTP            | 1     | API requests      |

See [Tools Reference](tools-reference.md) for details.

## 🆘 Getting Help

### Documentation Issues

If something in the docs is unclear:

1. Check [GitHub Issues](https://github.com/lvndry/jazz/issues)
2. Join [Discord](https://discord.gg/yBDbS2NZju)
3. Open a documentation issue

### Bug Reports

Found a bug?

1. Check [existing issues](https://github.com/lvndry/jazz/issues)
2. Open a [new issue](https://github.com/lvndry/jazz/issues/new)

### Feature Requests

Want a new feature?

1. Check [TODO.md](../TODO.md)
2. Open a [discussion](https://github.com/lvndry/jazz/discussions)
3. Submit a PR (see [CONTRIBUTING.md](../CONTRIBUTING.md))

## 🚀 Next Steps

1. **New to Jazz?** Start with [Getting Started](getting-started.md)
2. **Want inspiration?** Browse [Examples & Use Cases](examples.md)
3. **Ready to explore?** Check out [Tools Reference](tools-reference.md)
4. **Want to contribute?** Read [CONTRIBUTING.md](../CONTRIBUTING.md)
5. **Need help?** Join [Discord](https://discord.gg/yBDbS2NZju)

---

**Questions?** Join our community:

- 💬 [Discord](https://discord.gg/yBDbS2NZju)
- 🐛 [Issues](https://github.com/lvndry/jazz/issues)
- 💡 [Discussions](https://github.com/lvndry/jazz/discussions)
