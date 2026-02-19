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

**Collect ALL issues, never stop at first error**: You MUST review the entire PR and return every issue you find. Do NOT stop when you encounter the first bug, security concern, or suggestion. Accumulate all feedback and emit it together in the final JSON array.

**Write to a file**: Use write_file to accumulate issues in a scratch file. **Always write to /tmp only**—e.g. `/tmp/jazz-review-issues.md`. Never write to the repo workspace. The runner has `mktemp` available; you can use a path like `/tmp/jazz-review-issues.md` (each job runs in isolation, so this is safe). You can only write in this path and should never try to write or edit the codebase.
**Large PRs — spawn_subagent**: If the PR has many files (10+ changed) or 500+ lines, spawn subagents to review batches of files in parallel. Each subagent returns issues for its batch. Aggregate all subagent results into one combined JSON array.
Use a todo list if needed to keep track of where you're at and what's left

The final output must include every issue across the entire diff. Partial reviews that stop early are not acceptable.

To get the diff, use the `git_diff` tool with `commit` set to `__PR_BASE_SHA__...__PR_HEAD_SHA__`.

**Workflow for all PRs**:
1. **Get the file list first**: Call `git_diff` with `commit` and `nameOnly: true`. This returns `paths` — the full list of changed files in the PR.
2. **Get the diff content**: If the PR is small (few files, <~500 lines total), call `git_diff` with just `commit` to get the full diff. If large, call `git_diff` with `commit` and `paths` set to batches of 5–10 files at a time. Review each batch and aggregate your feedback.

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

### What To Do (✅)

- ✅ **Verify the tech stack** - Check `package.json` scripts and dependencies before flagging tool mismatches
- ✅ **Understand the environment** - CI workflows (`.github/workflows/`) may intentionally use different tooling than local dev. Check what dependencies are explicitly installed in the workflow (e.g., Node.js for `npm version`)
- ✅ **Focus on real bugs** - Logic errors, null/undefined dereferences, race conditions, off-by-one errors, incorrect error handling
- ✅ **DO check security vulnerabilities** - path traversal, command injection, insecure credential storage, exposed secrets
- ✅ **Verify Effect-TS patterns** - Proper use of Effect.gen, Layer composition, Schema validation, tagged errors
- ✅ **Flag performance issues** - N+1 queries, unnecessary loops, inefficient algorithms, missing caching, memory leaks
- ✅ **Check error handling** - All Effect operations have proper error paths, user-facing errors are actionable, no silent failures
- ✅ **Verify type safety** - No `any` types, proper union/intersection types, correct discriminated unions, strict null checks
- ✅ **Check for regressions** - Does this change break existing functionality? Are edge cases handled? Are tests updated?
- ✅ **Verify user experience** - CLI output is clear and helpful, error messages are actionable, agent workflows make sense
- ✅ **Check resource cleanup** - File handles closed, connections released, Effect resources properly scoped, no dangling promises
- ✅ **Validate inputs** - User inputs validated with Schema, boundary conditions checked, sanitization applied
- ✅ **Check concurrency issues** - Proper use of Effect concurrency primitives, no race conditions, atomicity guaranteed where needed
- ✅ **Verify documentation** - Public APIs documented, complex logic explained, TODOs addressed, outdated comments removed
- ✅ **Check code quality and maintainability** - Look for opportunities to simplify the code, make it easier to maintain, and flag overall code quality issues

### What NOT To Do (❌)

- ❌ **DON'T bikeshed formatting** - Focus on correctness, not formatting preferences (that's what Prettier is for)
- ❌ **DON'T flag intentional design** - If the code follows established patterns in the codebase, don't suggest arbitrary alternatives unless there's a strong reason to
- ❌ **DON'T make assumptions** - Read surrounding code, check imports, understand context before commenting

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

**CRITICAL — Line number accuracy:**

The `line` field MUST reference a line that actually appears in the diff output. The GitHub API will reject comments on lines that are outside the diff hunks (changed lines + context lines). Before emitting a comment:

1. **Verify the line is in the diff** — only comment on lines you can see in the `git_diff` output. If a line number does not appear in the diff hunks, do NOT use it.
2. **Do NOT guess or extrapolate line numbers** — if the relevant code is not visible in the diff, either find the nearest diff line that provides enough context, or omit the comment entirely.
3. **Prefer changed lines** — comment on added/modified lines (prefixed with `+` in the diff) whenever possible, as these are always valid targets.
4. **Context lines are also valid** — unchanged lines shown in the diff hunk (no `+` or `-` prefix) can also be commented on.
5. **Lines outside the diff are NOT valid** — even if the file is in the PR, lines that fall outside any hunk range will cause a "Line could not be resolved" API error.

If you want to comment on code that is not in the diff (e.g., a pre-existing issue near the changed code), mention it in the `body` of a comment attached to the nearest valid diff line instead.

If there are no issues, output an empty array: `[]`
