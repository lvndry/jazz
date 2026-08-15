# Contributing to Jazz

Thank you for your interest in contributing to Jazz! Please read the [Quick Start](docs/guide/quick-start.md) guide, and the [Code map](docs/internals/code-map.md) for how the codebase is organized.

## Project Structure

Jazz uses clean architecture with strict dependency rules:

- **`src/core/`** - Business logic, interfaces, types (no I/O)
- **`src/services/`** - Service implementations
- **`src/cli/`** - CLI commands and presentation

**Critical rule**: `core/` must **never** import from `services/` or `cli/`. Dependencies flow inward only.

Read the READMEs:

- `docs/guide/quick-start.md` - Install and first run
- `docs/internals/code-map.md` - Code organization and conventions
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

## Distributions

Jazz ships two ways, from one codebase:

| Command                 | Output                                       | Used by                     |
| ----------------------- | -------------------------------------------- | --------------------------- |
| `bun run build`         | `dist/main.js`, a bundle Node runs            | the `jazz-ai` npm package   |
| `bun run build:binary`  | `binaries/jazz-<os>-<arch>` for this machine  | local testing               |
| `bun run build:binaries`| every published target                        | `.github/workflows/release-binaries.yml` |

The binary is self-contained, which changes two things a contributor can trip over:

- **Built-in assets.** `personas/`, `skills/`, and `workflows/` are real directories the npm
  package resolves via `getPackageRootDirectory()`. A binary has no package directory, so the
  build embeds each file and Jazz unpacks them to `~/.jazz/runtime/<version>/` on first run.
  Adding a new built-in asset directory means adding it to `ASSET_DIRECTORIES` in
  `scripts/build.ts` — otherwise it works everywhere except in the binary.
- **Reading your own package files at runtime.** Anything that resolves a path relative to the
  installed package must go through `getPackageRootDirectory()`, which returns the unpacked
  directory in a binary. Reading straight from `import.meta.dirname` lands inside Bun's
  virtual filesystem, where `readFile` works but `readdir` and `copyFile` do not.

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
