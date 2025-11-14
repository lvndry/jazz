# Contributing to Jazz

Thanks for your interest in contributing to Jazz! We're excited to have you here. This guide explains how to set up your environment, follow the code style, write tests, and submit changes.

## 🎯 Where to Start

Jazz is actively developed with many opportunities to contribute:

### Ready-to-Work Tasks

- **[TODO.md](./TODO.md)** - Feature roadmap with planned enhancements
- **[Open Issues](https://github.com/lvndry/jazz/issues)** - Bug reports and feature requests
- **[Discussions](https://github.com/lvndry/jazz/discussions)** - Ideas and questions

### Contribution Ideas

- 🐛 **Fix Bugs** - Check issues labeled `bug` or `good first issue`
- ✨ **Add Features** - Pick from TODO.md or propose your own
- 📚 **Improve Docs** - Make Jazz easier to understand and use
- 🧪 **Write Tests** - Increase test coverage (see TODO.md)
- 🔧 **Add Integrations** - Google Calendar, Slack, Notion, and more!
- 🎨 **Enhance UX** - Better colors, streaming output, error messages

**First-time contributor?** Look for issues labeled `good first issue` or start with documentation improvements!

## Quick start

- Bun 1.x, Node.js >= 18
- Install: `bun install`
- Lint: `bun run lint`
- Build: `bun run build`
- Test: `bun test`
- Dev: `bun run dev`

## Getting started

1. Fork the repo and clone your fork
2. Create a branch from `main`:
   - Features: `feat/<topic>`
   - Fixes: `fix/<topic>`
   - Docs/Chores: `docs/<topic>` or `chore/<topic>`
3. Install dependencies: `bun install`
4. Develop using: `bun run dev`
5. Run checks locally: `bun run lint && bun run build && bun test`

## Project standards

This codebase is 100% TypeScript (strict) and uses Effect-TS.

- Prefer function declarations for top-level functions
- Use `interface` over `type` for object shapes
- Use discriminated unions for variants
- Always specify return types for public APIs
- Prefer `readonly` where applicable
- Validate external inputs with `@effect/schema`
- Wrap side effects in `Effect`; compose with `Effect.gen` and `pipe`
- Use `Effect.Layer` for dependency injection
- Use tagged errors via `Data.TaggedError`

Directory layout:

```
src/
  cli/
  core/
  services/
  main.ts
```

## Linting and formatting

- ESLint and Prettier are configured for TypeScript + Effect-TS best practices.
- Commands:
  - `bun run lint` — check
  - `bun run lint:fix` — fix
  - `bun run format` — format

## Build and run

- `bun run build` — typecheck + emit to `dist/`
- `bun run start` — run compiled CLI from `dist/main.js`
- `bun run dev` — watch mode for development

## Testing

- Use `bun test`
- Co-locate tests or use `__tests__` directories
- Test both success and error scenarios
- Prefer deterministic tests; mock external services with layers

Examples:

```
bun test
bun test --watch
```

## Commit messages (Conventional Commits)

Follow Conventional Commits for clear history and tooling:

- `feat(agent): add gmail tool registry`
- `fix(cli): handle unknown subcommand`
- `docs(readme): add usage examples`
- `chore(deps): bump eslint`
- `refactor(core): simplify runner`
- `test(services): cover error paths`

Reference issues when relevant, e.g. `(#123)`.

## Pull requests

Before opening a PR:

- All checks pass: `bun run lint && bun run build && bun test`
- Public APIs are typed and documented
- Update docs where needed (`README.md`, `docs/`)
- Avoid unrelated refactors; keep PRs focused and small
- Include screenshots/logs for UX/CLI changes when helpful

Target branch: `main`. Describe the problem, solution, and trade-offs.

## Continuous Integration

CI runs lint and build on pushes to `main` and on pull requests (see `.github/workflows/ci.yml`). Keep CI green; address flakes with a clear rationale if skipping.

## Security

- Do not commit secrets; use env vars locally
- Sanitize inputs and file paths
- Use least privilege for external APIs

## License

By contributing, you agree that your contributions are licensed under the MIT License included in this repository.

Thanks again for helping improve jazz! If you have questions, open an issue or discussion.
