# Jazz Documentation

Complete documentation for Jazz - Your AI agent that actually does things.

## 📚 Documentation Overview

### For New Users

**Start here:**

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

### Core Documentation

**Essential guides:**

3. **[Tools Reference](tools-reference.md)** - Complete guide to all 44 tools across 6 categories
   - Gmail tools (16 tools)
   - Git tools (9 tools)
   - File management tools (15 tools)
   - Shell tools (2 tools)
   - Web search tools (1 tool)
   - HTTP tools (1 tool)
   - Examples and best practices

4. **[CLI Reference](cli-reference.md)** - Command-line interface documentation
   - All commands and options
   - Usage examples
   - Troubleshooting
   - Quick reference

5. **[Integrations](integrations.md)** - Set up external services
   - LLM providers (OpenAI, Anthropic, Google, Mistral, xAI, DeepSeek, Ollama)
   - Gmail integration (OAuth setup)
   - Linkup web search
   - Configuration examples

6. **[Security](security.md)** - Security model and best practices
   - Understanding risks
   - Security features
   - Approval system
   - Best practices
   - Incident response

## 🗺️ Navigation Guide

### By Task

**I want to...**

- **Get started quickly** → [Getting Started](getting-started.md)
- **See what's possible** → [Examples & Use Cases](examples.md)
- **Understand what tools are available** → [Tools Reference](tools-reference.md)
- **Set up Gmail** → [Integrations > Gmail](integrations.md#gmail-integration)
- **Set up web search** → [Integrations > Linkup](integrations.md#linkup-web-search)
- **Configure LLM providers** → [Integrations > LLM Providers](integrations.md#llm-providers)
- **Learn CLI commands** → [CLI Reference](cli-reference.md)
- **Understand security** → [Security Guide](security.md)
- **Troubleshoot issues** → [CLI Reference > Troubleshooting](cli-reference.md#troubleshooting)

### By Role

**For End Users:**

- [Getting Started](getting-started.md) - How to use Jazz
- [Examples & Use Cases](examples.md) - Real-world workflows
- [Tools Reference](tools-reference.md) - What your agents can do
- [Security](security.md) - Stay safe

**For Developers:**

- [Examples & Use Cases](examples.md) - Advanced automation patterns
- [Integrations](integrations.md) - API keys and setup
- [CLI Reference](cli-reference.md) - Command details
- [../CONTRIBUTING.md](../CONTRIBUTING.md) - Contributing guide
- [../TODO.md](../TODO.md) - Feature roadmap

**For System Administrators:**

- [Security](security.md) - Security model
- [Integrations](integrations.md) - Deployment configuration
- [CLI Reference](cli-reference.md) - System integration

## 📖 Reading Order

### Beginner Path

1. Start with [Getting Started](getting-started.md)
2. Explore [Examples & Use Cases](examples.md) for inspiration
3. Read [Tools Reference](tools-reference.md) to understand capabilities
4. Review [Security](security.md) for safe usage
5. Set up [Integrations](integrations.md) as needed

### Advanced Path

1. Study [Examples & Use Cases](examples.md) for complex workflows
2. [CLI Reference](cli-reference.md) for command details
3. [Tools Reference](tools-reference.md) for deep tool knowledge
4. [Integrations](integrations.md) for multi-provider setup
5. [Security](security.md) for advanced security practices

## 🔍 Quick Reference

### Configuration

**Minimal setup:**

```json
{
  "llm": {
    "openai": {
      "api_key": "sk-..."
    }
  }
}
```

**Full setup:**

See [Integrations > Configuration Examples](integrations.md#configuration-examples)

### Common Commands

```bash
# Agent Management
jazz agent create              # Create agent
jazz agent list               # List agents
jazz agent chat <name>        # Chat with agent

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

### Usage Questions

For help using Jazz:

1. Check [Getting Started](getting-started.md)
2. See [CLI Reference > Troubleshooting](cli-reference.md#troubleshooting)
3. Ask in [Discord](https://discord.gg/yBDbS2NZju)
4. Search [GitHub Discussions](https://github.com/lvndry/jazz/discussions)

### Bug Reports

Found a bug?

1. Check [existing issues](https://github.com/lvndry/jazz/issues)
2. Open a [new issue](https://github.com/lvndry/jazz/issues/new)

### Feature Requests

Want a new feature?

1. Check [TODO.md](../TODO.md)
2. Open a [discussion](https://github.com/lvndry/jazz/discussions)
3. Submit a PR (see [CONTRIBUTING.md](../CONTRIBUTING.md))

## 🔄 Document Updates

These docs are for **Jazz v0.2.0** and are actively maintained.

**Last updated:** January 2024

**Contributing to docs:**

- Docs are written in Markdown
- See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines
- Submit PRs for improvements

## 📋 Document Status

| Document             | Status     | Last Updated |
| -------------------- | ---------- | ------------ |
| Getting Started      | ✅ Current | Jan 2024     |
| Examples & Use Cases | ✅ Current | Jan 2024     |
| Tools Reference      | ✅ Current | Jan 2024     |
| CLI Reference        | ✅ Current | Jan 2024     |
| Integrations         | ✅ Current | Jan 2024     |
| Security             | ✅ Current | Jan 2024     |

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
