# Contributing to Jazz

## Quick Start

```bash
bun install
bun run build
bun test
bun run lint
bun run cli
```

## Project Structure

Jazz uses clean architecture with strict dependency rules:

- **`src/core/`** - Business logic, interfaces, types (no I/O)
- **`src/services/`** - Service implementations
- **`src/cli/`** - CLI commands and presentation

**Critical rule**: `core/` must **never** import from `services/` or `cli/`. Dependencies flow inward only.

Read the READMEs:

- `src/core/README.md` - Core layer patterns
- `src/services/README.md` - Service implementations
- `src/cli/README.md` - CLI commands
- `docs/ARCHITECTURE.md` - System architecture
- `docs/FAQ.md` - Common patterns

## Key Best Practices

### Code Style

- **Function declarations** (not arrow functions) for top-level functions
- **Effect-TS** for all async operations - use `Effect.gen`, not `async/await`
- **Interfaces** (not types) for object shapes
- **Tagged errors** using `Data.TaggedError` for error handling
- **Always specify return types** for public functions

### Architecture

When adding features:

- **New service**: Add interface to `src/core/interfaces/<name>.ts` and implementation to `src/services/<name>.ts`
- **Business logic**: Add to `src/core/agent/` or `src/core/utils/` (keep it pure, no I/O)
- **CLI command**: Add to `src/cli/commands/<name>.ts` and register in `src/cli/commands/index.ts`

### Testing

- Tests use `.test.ts` extension in the same directory
- Use Effect's `Layer` for dependency injection in tests
- Mock external dependencies (no real API calls)

## Before Submitting PR

- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] `bun test` passes
- [ ] `bun run build` succeeds
- [ ] Update relevant READMEs if interfaces change

## Getting Help

- **Issues**: [GitHub Issues](https://github.com/lvndry/jazz/issues)
- **Discussions**: [GitHub Discussions](https://github.com/lvndry/jazz/discussions)
- **Discord**: [Join our community](https://discord.gg/yBDbS2NZju)

Need help with a PR? Open a draft PR and ask - maintainers will help iterate.
