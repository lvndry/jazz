---
name: documentation
description: Generate or update documentation from code, APIs, and context. Use when documenting code, writing README, API docs, or keeping docs in sync with implementation.
---

# Documentation

Generate and update documentation from code, OpenAPI/schemas, and project context. Keep docs in sync with implementation.

## When to Use

- User wants a README, API docs, or inline docs
- User asks to document a module, function, or API
- User wants docs updated after code changes
- New project needs initial documentation

## Workflow

1. **Identify target**: What needs documenting? (repo, module, API, CLI)
2. **Gather sources**: Code, types, OpenAPI/schema, existing docs
3. **Choose format**: README, JSDoc/TSDoc, API reference, user guide
4. **Draft**: Structure first, then fill from code/context
5. **Verify**: Links, code blocks, commands actually run

## Documentation Types

| Type | When | Output |
|------|------|--------|
| **README** | Project or package overview | README.md with install, usage, API summary |
| **API reference** | Functions, endpoints, types | JSDoc, or docs/api.md, or OpenAPI-derived |
| **User guide** | How to use a feature or product | Step-by-step, examples, troubleshooting |
| **Inline docs** | Functions, classes, exports | JSDoc/TSDoc, docstrings |
| **Changelog** | Release history | CHANGELOG.md format |

## README Structure

```markdown
# Project Name

[One-line description]

## Install

\`\`\`bash
npm install <package>
\`\`\`

## Quick Start

[Minimal example to get running]

## Usage

[Main use cases with examples]

## API

[Summary or link to full API docs]

## Config

[Options, env vars, config file]

## Contributing / License

[Brief or link]
```

Infer content from: `package.json` (name, description, scripts), main entry, existing tests.

## API Documentation

For **code APIs** (exports, functions):
- Use JSDoc/TSDoc: `@param`, `@returns`, `@example`
- One sentence summary, then params, return, throws, example
- Keep examples runnable and short

For **HTTP/REST APIs**:
- If OpenAPI/Swagger exists, derive sections from it
- Include: endpoint, method, params, body schema, response, example
- Group by resource or tag

For **CLI**:
- Document command, options, subcommands
- One example per common use case
- Exit codes or errors if non-obvious

## Inline Docs (JSDoc/TSDoc)

```typescript
/**
 * Fetches user by ID. Returns null if not found.
 *
 * @param id - User UUID
 * @param options - Optional fetch settings
 * @returns User or null
 * @throws {NetworkError} When request fails
 *
 * @example
 * const user = await getUser("abc-123");
 */
export async function getUser(id: string, options?: FetchOptions): Promise<User | null> {
```

Extract types from signature; don't repeat them in prose. Focus on intent, edge cases, and examples.

## Keeping Docs in Sync

- After refactors: update README examples, API section, and affected JSDoc
- When adding params or return types: update JSDoc and any API.md
- When changing CLI flags: update CLI docs and README usage

Check: Do code blocks run? Do linked files exist? Are version numbers current?

## Tone and Style

- Present tense ("Returns the user" not "Will return")
- Second person for user-facing ("You can pass..." or "Pass a path to...")
- Short sentences; bullets for lists
- Code examples over long prose

## Anti-Patterns

- ❌ README that only says "See code"
- ❌ API docs that duplicate the type signature with no explanation
- ❌ Outdated examples that don't run
- ❌ Missing install or run instructions for a package
