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

Jazz ships one artifact — a self-contained standalone binary — through two channels, from one
codebase:

| Command                      | Output                                         | Used by                                                     |
| ----------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| `bun run build:binary`        | `binaries/jazz-<os>-<arch>` for this machine     | local testing                                                 |
| `bun run build:binaries`      | every published target                           | `.github/workflows/release-binaries.yml`                     |
| `bun run stage-npm-packages`  | binaries copied into `npm/jazz-ai-<platform>/`   | the npm publish job in `.github/workflows/release-binaries.yml` |

Installing via `curl \| bash` gets the binary directly; `npm i -g jazz-ai` gets a thin wrapper
package whose `postinstall` copies in the matching binary from one of the `jazz-ai-<platform>`
optionalDependencies (see `npm/`). Both end up running the same compiled binary.

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

`npm/` holds the packages actually published to npm — the repo root's `package.json` is
`private` and never gets published itself.

- `npm/jazz-ai/` — the `jazz-ai` package end users install. Ships `bin/jazz` (a guard script
  that errors if `postinstall` didn't run), `postinstall.mjs` (copies in the real binary from
  whichever platform package resolved), and `package.json` (`optionalDependencies` listing all
  six platform packages).
- `npm/jazz-ai-<platform>/` — one package per `os`/`cpu`/`libc` combination in
  `COMPILE_TARGETS` (`scripts/build.ts`), e.g. `jazz-ai-darwin-arm64`. Each ships only
  `package.json` in git; its `bin/jazz` binary is generated, not committed.

`bun run scripts/build.ts --npm-packages-from-dir <dir>` stamps every `npm/*/package.json`
version to match the root manifest and copies in binaries from `<dir>`. The
`publish-npm` job in `release-binaries.yml` runs this after `build`, using the same
macOS-signed binaries that job already produced, then runs `npm publish` from each platform
package directory before `npm/jazz-ai` — its `optionalDependencies` pin exact versions of
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
