# Getting Started - Contributors

This guide is for contributors who want to develop Jazz locally.

## Prerequisites

- Node.js 18 or higher
- Bun (recommended) or npm/pnpm/yarn

## Setup

### 1. Clone and Install

```bash
git clone https://github.com/lvndry/jazz.git
cd jazz
bun install
```

### 2. Run Jazz

```bash
# Run any Jazz command
bun run cli <command>

# For example:
bun run cli --version
bun run cli agent list
```

### 3. Configure LLM Provider

Jazz needs at least one LLM provider. You can configure it in two ways:

**Option 1: During agent creation (recommended)**

```bash
bun run cli agent create
# The wizard will guide you through LLM setup
```

**Option 2: Using config command**

```bash
bun run cli config set llm
# Follow the prompts to configure your LLM provider
```

**Get API Keys:**

- **OpenAI**: [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- **Anthropic**: [console.anthropic.com](https://console.anthropic.com/)
- **Google**: [makersuite.google.com/app/apikey](https://makersuite.google.com/app/apikey)

See [integrations.md](integrations.md) for all providers.

## Development Workflow

### Running Tests

```bash
# Run all tests
bun test
```

### Type Checking

```bash
bun run typecheck
```

### Linting

```bash
bun run lint

# Auto-fix issues
bun run lint:fix
```

### Building

```bash
# Build once
bun run build

# Watch mode (rebuilds on changes)
bun run build:watch
```

### Testing Your Changes

After making changes:

```bash
# Test the CLI
bun run cli agent create
bun run cli agent list
```

## Key Files

- **Tool Definitions**: `src/core/agent/tools/*-tools.ts`
- **Model Definitions**: `src/core/constants/models.ts`
- **Agent Runner**: `src/core/agent/agent-runner.ts`
- **CLI Entry**: `src/main.ts`

## Creating Your First Agent (for testing)

```bash
bun run cli agent create

# Configure with:
# - Name: test-agent
# - Description: Testing my changes
# - Provider: openai (or your configured provider)
# - Model: gpt-4o-mini
# - Tools: Select any tools you're testing
```

## Common Development Tasks

### Adding a New Tool

1. Add tool definition in `src/core/agent/tools/`
2. Register in `src/core/agent/tools/register-tools.ts`
3. Add tests in `src/core/agent/tools/*-tools.test.ts`
4. Update `docs/tools-reference.md`

### Adding a New LLM Provider

1. Add models in `src/core/constants/models.ts`
2. Update `src/services/llm/models.ts`
3. Add provider config in `src/core/config/schema.ts`
4. Update `docs/integrations.md`

### Adding a New CLI Command

1. Create command in `src/cli/commands/`
2. Register in `src/cli/index.ts`
3. Add tests
4. Update `docs/cli-reference.md`

## Debugging

### Enable Debug Logging

```bash
bun run cli --debug agent chat test-agent
```

### Check Logs

```bash
# Logs are stored in
~/.jazz/logs/

# View recent logs
tail -f ~/.jazz/logs/agent-*.log
```

### Common Issues

**"Module not found" errors:**

```bash
bun install
bun run build
```

**Type errors:**

```bash
bun run typecheck
```

**Tests failing:**

```bash
# Run specific test to see details
bun test src/path/to/test.ts
```

## Before Submitting a PR

```bash
# 1. Run all checks
bun run typecheck
bun run lint
bun test

# 2. Build successfully
bun run build

# 3. Test the CLI manually
bun run cli agent create
bun run cli agent chat test-agent

# 4. Update documentation if needed
# - docs/tools-reference.md (for tool changes)
# - docs/integrations.md (for provider changes)
# - README.md (for major features)
```

## Code Style

- Use TypeScript strict mode
- Follow Effect-TS patterns for error handling
- Use Schema for validation
- Write tests for new features
- Document public APIs
- Keep functions focused and small

## Architecture Guidelines

See [AGENTS.md](../AGENTS.md) for detailed architecture guidelines and best practices.

## Getting Help

- **Discord**: [discord.gg/yBDbS2NZju](https://discord.gg/yBDbS2NZju)
- **GitHub Issues**: [github.com/lvndry/jazz/issues](https://github.com/lvndry/jazz/issues)
- **Discussions**: [github.com/lvndry/jazz/discussions](https://github.com/lvndry/jazz/discussions)

---

**Ready to contribute?** Check [CONTRIBUTING.md](../CONTRIBUTING.md) for PR guidelines and code review process.
