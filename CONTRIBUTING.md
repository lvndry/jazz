# Contributing to Jazz

Thank you for your interest in contributing to Jazz! Please read the [Quick Start](docs/guide/quick-start.md) guide, and the [Code map](docs/internals/code-map.md) for how the codebase is organized.

## Workspace

Jazz is a Bun workspace (`packages/*`), split along clean-architecture lines with the boundary
structurally enforced by TypeScript project references — `tsc -b` rejects a package importing
from one it doesn't declare as a dependency, not just a documented convention.

| Package             | Purpose                                                          | Depends on                      |
| -------------------- | ----------------------------------------------------------------- | --------------------------------- |
| `packages/core`       | Business logic, interfaces, types (no I/O); publishable as `@jazz/core` | nothing else in the workspace     |
| `packages/adapters`   | Service implementations (LLM, storage, MCP, keyring, etc.)         | `core`                            |
| `packages/cli`        | Ink/OpenTUI commands and presentation                              | `core`                            |
| `packages/runtime`    | Composition root — wires core+adapters+cli into the `jazz` binary  | `core`, `adapters`, `cli`         |
| `packages/bot-shared`  | Shared run-logging/usage helpers for the bot bridges                | `core`                            |
| `packages/telegram-bot`| Telegram bridge                                                    | `core`, `adapters`, `bot-shared`  |
| `packages/discord-bot` | Discord bridge                                                     | `core`, `adapters`, `bot-shared`  |
| `packages/website`    | Astro docs/marketing site, reads `docs/` as a content collection    | `cli` (design tokens only)        |

**Critical rule**: `core/` must **never** import from `adapters/`, `cli/`, or `runtime/`.
Dependencies flow inward only.

Read the READMEs:

- `docs/guide/quick-start.md` - Install and first run
- `docs/internals/code-map.md` - Code organization and conventions
- `packages/core/README.md` - Core package patterns
- `packages/adapters/README.md` - Adapter implementations
- `packages/cli/README.md` - CLI commands
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

- **New service**: Add interface to `packages/core/src/interfaces/<name>.ts` and implementation to `packages/adapters/src/<name>.ts`
- **Business logic**: Add to `packages/core/src/agent/` or `packages/core/src/utils/` (keep it pure, no I/O)
- **CLI command**: Add to `packages/cli/src/commands/<name>.ts` and register in `packages/runtime/src/cli-app.ts`

### Testing

- Tests use `.test.ts` extension in the same directory
- Use Effect's `Layer` for dependency injection in tests
- Mock external dependencies (no real API calls)

## Distributions

Jazz ships one artifact — a self-contained standalone binary — through two channels, from one
codebase:

| Command                      | Output                                         | Used by                                                     |
| ----------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| `bun run build:binary`        | `deploy/binaries/jazz-<os>-<arch>` for this machine | local testing                                                 |
| `bun run build:binaries`      | every published target                           | `.github/workflows/release-binaries.yml`                     |
| `bun run stage-npm-packages`  | binaries copied into `deploy/npm/jazz-ai-<platform>/` | the npm publish job in `.github/workflows/release-binaries.yml` |

Installing via `curl \| bash` gets the binary directly; `npm i -g jazz-ai` gets a thin wrapper
package whose `postinstall` copies in the matching binary from one of the `jazz-ai-<platform>`
optionalDependencies (see `deploy/npm/`). Both end up running the same compiled binary.

The binary is self-contained, which changes two things a contributor can trip over:

- **Built-in assets.** `personas/`, `skills/`, and `workflows/` are real directories the repo
  root resolves via `getPackageRootDirectory()` in development. A binary has no package
  directory, so the build embeds each file and Jazz unpacks them to `~/.jazz/runtime/<version>/`
  on first run.
  Adding a new built-in asset directory means adding it to `ASSET_DIRECTORIES` in
  `scripts/build.ts` — otherwise it works everywhere except in the binary.
- **Reading your own package files at runtime.** Anything that resolves a path relative to the
  installed package must go through `getPackageRootDirectory()`, which returns the unpacked
  directory in a binary. Reading straight from `import.meta.dirname` lands inside Bun's
  virtual filesystem, where `readFile` works but `readdir` and `copyFile` do not.

### npm package layout

`deploy/npm/` holds the packages actually published to npm — the repo root's `package.json` is
`private` and never gets published itself.

- `deploy/npm/jazz-ai/` — the `jazz-ai` package end users install. Ships `bin/jazz` (a guard
  script that errors if `postinstall` didn't run), `postinstall.mjs` (copies in the real binary
  from whichever platform package resolved), and `package.json` (`optionalDependencies` listing
  all six platform packages).
- `deploy/npm/jazz-ai-<platform>/` — one package per `os`/`cpu`/`libc` combination in
  `COMPILE_TARGETS` (`scripts/build.ts`), e.g. `jazz-ai-darwin-arm64`. Each ships only
  `package.json` in git; its `bin/jazz` binary is generated, not committed.

`bun run scripts/build.ts --npm-packages-from-dir <dir>` stamps every `deploy/npm/*/package.json`
version to match the root manifest and copies in binaries from `<dir>`. The
`publish-npm` job in `release-binaries.yml` runs this after `build`, using the same
macOS-signed binaries that job already produced, then runs `npm publish` from each platform
package directory before `deploy/npm/jazz-ai` — its `optionalDependencies` pin exact versions of
them, so publishing `jazz-ai` first would point at versions that don't exist yet.

Publishing a brand-new platform package for the first time requires registering it as an npm
Trusted Publisher for this workflow, the same way `jazz-ai` itself already is — npm has no
existing trust relationship for a package name it has never seen published.

## Before Submitting PR

- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] `bun test` passes
- [ ] `bun run build:binary` succeeds
- [ ] Update relevant READMEs if interfaces change

## Getting Help

- **Issues**: [GitHub Issues](https://github.com/lvndry/jazz/issues)
- **Discussions**: [GitHub Discussions](https://github.com/lvndry/jazz/discussions)
- **Discord**: [Join our community](https://discord.gg/yBDbS2NZju)

Need help with a PR? Open a draft PR and ask - maintainers will help iterate.
