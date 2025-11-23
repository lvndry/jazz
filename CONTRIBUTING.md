# Contributing to Jazz

Thanks for your interest in contributing to Jazz! We're excited to have you here. This guide explains how to set up your environment, follow the code style, write tests, and submit changes.

## 🎯 Where to Start

Jazz is actively developed with many opportunities to contribute:

### Ready-to-Work Tasks

- **[TODO.md](./TODO.md)** - Feature roadmap with planned enhancements
- **[Open Issues](https://github.com/lvndry/jazz/issues)** - Bug reports and feature requests
- **[Discussions](https://discord.gg/yBDbS2NZju)** - Ideas and questions

### Contribution Ideas

- 🐛 **Fix Bugs** - Check issues labeled `bug` or `good first issue`
- ✨ **Add Features** - Pick from TODO.md or propose your own
- 📚 **Improve Docs** - Make Jazz easier to understand and use
- 🧪 **Write Tests** - Increase test coverage (see TODO.md)
- 🔧 **Add Integrations** - Google Calendar, Slack, Notion, and more!
- 🎨 **Enhance UX** - Better colors, streaming output, error messages

**First-time contributor?** Look for issues labeled `good first issue` or start with documentation improvements!

## Prerequisites

- Bun 1.x
- Node.js >= 18

## Getting started

1. Fork the repo and clone your fork
2. Create a branch from `main`:
   - Features: `feat/<topic>`
   - Fixes: `fix/<topic>`
   - Docs/Chores: `docs/<topic>` or `chore/<topic>`
3. Install dependencies: `bun install`
4. Develop using: `bun run dev agent [command]`
5. Run checks locally: `bun run lint && bun run build && bun test`

## Project standards

This codebase is 100% TypeScript and uses Effect-TS. Follow these critical patterns:

- Use `Data.TaggedError` for all error types (see `src/core/types/errors.ts` for examples)
- Always use `Effect.gen` for async workflows, never async/await
- Use `yield*` to unwrap Effects inside `Effect.gen` blocks
- Services are provided via `Effect.Layer`, never imported directly
- Access services with `yield* ServiceTag` inside `Effect.gen`
- Use `Effect.catchAll` to handle errors, never try/catch
- Use `Schema` from `@effect/schema` to validate all external inputs at boundaries
- Always specify return types for public APIs

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

## Pull requests

Before opening a PR:

- All checks pass: `bun run lint && bun run build && bun test`
- Public APIs are typed and documented
- Update docs where needed (`README.md`, `docs/`)
- Avoid unrelated refactors; keep PRs focused and small
- Include screenshots/logs for UX/CLI changes when helpful

Target branch: `main`. Describe the problem, solution, and trade-offs.

## Security

- Do not commit secrets; use env vars locally
- Sanitize inputs and file paths
- Use least privilege for external APIs

## License

By contributing, you agree that your contributions are licensed under the MIT License included in this repository.

Thanks again for helping improve jazz! If you have questions, open an issue or discussion.
