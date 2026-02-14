---
name: code-review
description: Review pull request changes for quality, security, and correctness
autoApprove: true
agent: ci-reviewer
maxIterations: 100
skills:
  - code-review
---

# Pull Request Code Review

Review the changes in this pull request.

To get the diff, use the `git_diff` tool with `commit` set to `__PR_BASE_SHA__...__PR_HEAD_SHA__`.

If the diff is large or truncated, re-run scoped to individual files using the `path` parameter.

Use the `code-review` skill for the full review checklist. This review is the single gate for PR quality—catch bugs (logic errors, null dereferences, race conditions, regressions), error-handling gaps, and security issues as part of your review.

## Project Context

**Jazz** is an agentic automation CLI that empowers users to create, manage, and orchestrate autonomous AI agents for complex workflows. Think of it as your personal army of AI assistants that can handle everything from email management to code deployment.

### Tech Stack

- **Runtime**: Bun (NOT Node.js/npm) - all scripts use `bun` commands
- **Language**: 100% TypeScript with strict mode
- **Framework**: Effect-TS for functional programming, error handling, and dependency injection
- **Package Manager**: Bun
- **Testing**: Bun's built-in test runner
- **Build**: Custom build scripts using Bun

### Key Architecture Patterns

- Effect-TS Layers for dependency injection
- Schema for runtime validation
- Functional, immutable, composable code
- CLI-first design with Commander.js
- Rendering using Ink
- Multi-LLM support (OpenAI, Anthropic, Google, Mistral, xAI, DeepSeek, Ollama)

## Jazz-Specific Review Focus

In addition to the code-review checklist, pay special attention to:

### TypeScript & Effect-TS

- Follow TypeScript and Effect-TS best practices. Avoid `any`.

### Jazz UX Impact

- **CLI-first**: Changes affect the CLI experience—clear output, sensible defaults, helpful errors?
- **Agent workflow**: How does this fit into agent workflows? Could it confuse or frustrate users running agents headlessly?
- **Graceful failure**: When things go wrong, does the user get actionable feedback? No cryptic stack traces or silent failures?
- **User intent**: Does the change align with "automation should be intelligent, not just mechanical"?

### Long-Term Maintainability

- **Extensibility**: Is this easy to extend or will it require large refactors later?
- **Documentation**: Public APIs and non-obvious logic documented? Outdated docs removed?
- **Coupling**: Dependencies clear and minimal? Effect layers used properly?
- **Testing**: New behavior covered? Error paths and edge cases tested?

## Review Guidelines

- ✅ **DO verify the tech stack** - Check `package.json` scripts and dependencies
- ✅ **DO focus on real issues** - Logic errors, null safety, race conditions, security vulnerabilities, Effect-TS anti-patterns.

**When in doubt**: Read the surrounding code and project files to understand the context. Don't flag issues based on assumptions about the tech stack.

## Output Format

You MUST output ONLY a JSON array as the very last thing you write, wrapped in a ````json fenced code block (use FOUR backticks so triple backticks inside the body field don't break the fence).
Do NOT output anything after the JSON block.
When flagging issues, suggest concrete edits (code snippets or exact changes) when possible.

Each element represents one review comment tied to a specific file and line(s):

````json
[
  {
    "path": "src/example.ts",
    "line": 42,
    "side": "RIGHT",
    "body": "**Critical**: This can throw if `user` is null.\n\nSuggestion:\n```ts\nif (!user) return;\n```"
  },
  {
    "path": "src/utils.ts",
    "line": 55,
    "start_line": 48,
    "side": "RIGHT",
    "body": "**Suggestion**: Consider extracting this block into a helper."
  }
]
````

Rules:

- `path`: relative file path from repo root (must exist in the diff)
- `line`: line number; use the NEW version (RIGHT side) for added/modified files, or the OLD version (LEFT side) for deleted files
- `start_line`: (optional) start line for multi-line block comments; omit for single-line
- `side`: "RIGHT" for added/modified files (comment on new code); use "LEFT" or omit for deleted files (the CI workflow auto-detects removed files and uses LEFT)
- `body`: markdown comment — include severity (Critical/Suggestion/Nice-to-have), explanation, and a concrete fix when possible

If there are no issues, output an empty array: `[]`
