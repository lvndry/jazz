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

### 2. Build the Project

```bash
bun run build
```

### 3. Link for Local Development

```bash
# Link the CLI globally to test your changes
bun link

# Now you can use 'jazz' command with your local changes
jazz --version
```

### 4. Configure LLM Provider

Jazz needs at least one LLM provider. Create `~/.jazz/config.json`:

```json
{
  "llm": {
    "openai": {
      "api_key": "sk-..."
    }
  }
}
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

# Run specific test file
bun test src/core/agent/tools/fs-tools.test.ts

# Watch mode
bun test --watch
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
# 1. Rebuild
bun run build

# 2. Test the CLI
jazz agent create
jazz agent list
```

## Project Structure

```
src/
├── cli/              # CLI commands and presentation
│   ├── commands/     # Agent, auth, config commands
│   └── presentation/ # Output rendering, themes
├── core/             # Core domain logic
│   ├── agent/        # Agent runtime, tools, tracking
│   ├── config/       # Configuration management
│   └── types/        # Type definitions
└── services/         # External integrations
    ├── llm/          # LLM providers (OpenAI, Anthropic, etc.)
    ├── gmail/        # Gmail integration
    └── logger.ts     # Logging service
```

## Key Files

- **Tool Definitions**: `src/core/agent/tools/*-tools.ts`
- **Model Definitions**: `src/core/constants/models.ts`
- **Agent Runner**: `src/core/agent/agent-runner.ts`
- **CLI Entry**: `src/main.ts`

## Creating Your First Agent (for testing)

```bash
jazz agent create

# Configure with:
# - Name: test-agent
# - Description: Testing my changes
# - Provider: openai (or your configured provider)
# - Model: gpt-4o-mini
# - Tools: Select any tools you're testing
```

## Testing Specific Features

### Testing Tool Changes

If you modified a tool (e.g., `gmail-tools.ts`):

```bash
# 1. Rebuild
bun run build

# 2. Create agent with that tool
jazz agent create --tools gmail

# 3. Test the tool
jazz agent chat test-agent
> "List my emails"  # Test your changes
```

### Testing Agent Runner Changes

```bash
# Enable debug mode to see detailed logs
jazz --debug agent chat test-agent
```

### Testing Configuration Changes

```bash
# View current config
jazz config show

# Set config values
jazz config set llm.openai.api_key "sk-..."
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
jazz --debug agent chat test-agent
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
jazz agent create
jazz agent chat test-agent

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

## Quick Reference

```bash
# Development
bun install              # Install dependencies
bun run build           # Build project
bun link                # Link CLI globally
bun test                # Run tests
bun run typecheck       # Type check
bun run lint            # Lint code

# Testing
jazz --debug agent chat test-agent  # Debug mode
jazz --version                      # Check version
jazz config show                    # View config

# Logs
~/.jazz/logs/           # Log directory
~/.jazz/config.json     # Config file
```

---

**Ready to contribute?** Check [CONTRIBUTING.md](../CONTRIBUTING.md) for PR guidelines and code review process.
