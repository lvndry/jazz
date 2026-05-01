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

**Accuracy beats volume.** A short, true review is better than a long one full of speculative concerns. Reviewers and authors lose trust in this agent fast if it raises false alarms — and ignoring its real findings later is the cost. Returning an empty array `[]` is a perfectly valid outcome when the diff is sound. Do NOT pad the output to feel thorough.

**Calibration rule:** Only emit a comment if you are >70% confident the issue is real after reading the actual code in context. If you're flagging a category of bug ("race condition", "missing validation", "type-safety gap"), you must be able to point to the *specific lines* and *specific failure mode* — not the abstract concept. If you can't, skip it.

**Cover the whole diff.** Read every changed file. Don't stop at the first issue you find — accumulate findings across the entire PR before emitting. But "cover" means *consider*; it does not mean every file must produce a comment.

**Write to a file**: Use write_file to accumulate issues in a scratch file. **Always write to /tmp only**—e.g. `/tmp/jazz-review-issues.md`. Never write to the repo workspace. The runner has `mktemp` available; you can use a path like `/tmp/jazz-review-issues.md` (each job runs in isolation, so this is safe). You can only write in this path and should never try to write or edit the codebase.

**Large PRs — spawn_subagent**: If the PR has many files (10+ changed) or 500+ lines, spawn subagents to review batches of files in parallel. Each subagent returns issues for its batch. Aggregate all subagent results into one combined JSON array.

Use a todo list if needed to keep track of where you're at and what's left.

## Context

- Repository checkout path: `__WORKSPACE__` (the absolute path to the working tree on this runner — every git/file tool call MUST pass this as the `path` argument; the runner's default cwd is not the repository).
- PR context snapshot: `/tmp/jazz-pr-context.json` — a JSON object with `title`, `body` (PR description), `labels`, `comments` (top-level conversation), `reviews` (review summaries with bodies and states), and `reviewComments` (inline per-line review comments). Read this with `read_file` BEFORE reviewing the diff so you (a) understand what the PR claims to do, (b) avoid re-flagging issues already raised by human reviewers, and (c) factor in any prior round of feedback.

**Workflow for all PRs**:
1. **Read the PR context snapshot**: `read_file` with `path: "/tmp/jazz-pr-context.json"`. Note the title, description, and any prior reviews/comments — they tell you the author's intent and what's already been discussed. **If the file is missing or contains `{"error": ...}`** (e.g. running on an older driver workflow that didn't pre-fetch context), proceed without it: continue with steps 2–3 and just don't reference PR metadata in your output. Do not ask for retry; do not block on this.
2. **Get the file list**: Call `git_diff` with `path: "__WORKSPACE__"`, `commit: "__PR_BASE_SHA__...__PR_HEAD_SHA__"`, and `nameOnly: true`. This returns `paths` — the full list of changed files in the PR.
3. **Get the diff content**: If the PR is small (few files, <~500 lines total), call `git_diff` with `path: "__WORKSPACE__"` and `commit: "__PR_BASE_SHA__...__PR_HEAD_SHA__"` to get the full diff. If large, also pass `paths` set to batches of 5–10 files at a time. Review each batch and aggregate your feedback.
4. When using `read_file`, `ls`, `find`, or `grep` for source code, pass paths under `__WORKSPACE__/...`.

Use the `code-review` skill for the full review checklist. This review is the single gate for PR quality—catch bugs (logic errors, null dereferences, race conditions, regressions), error-handling gaps, and security issues as part of your review.

## Project Context

**Jazz** is an agentic automation CLI that empowers users to create, manage, and orchestrate autonomous AI agents for complex workflows. It runs in a terminal: a single user invokes `jazz`, types prompts, agents respond and call tools, the process exits when the user exits.

### Tech Stack

- **Runtime**: Bun (NOT Node.js/npm) - all scripts use `bun` commands
- **Language**: 100% TypeScript with strict mode
- **Framework**: Effect-TS for functional programming, error handling, and dependency injection
- **Package Manager**: Bun
- **Testing**: Bun's built-in test runner
- **Build**: Custom build scripts using Bun

### Runtime Model — read before flagging concurrency or "race" issues

- **Single-threaded JavaScript event loop.** Bun runs the same JS execution model as Node: one OS thread executes user code, with cooperative concurrency via Promises / `async`/`await` / Effect fibers. There is no preemptive multithreading. Two synchronous functions cannot interleave with each other or with themselves. A "shared state + multiple methods" pattern is *not* a race condition.
- **Where concurrency actually exists**: across `await` boundaries, `Promise.all`, `Effect.fork` / `Effect.race` / parallel combinators, MCP server I/O, HTTP requests to LLM providers, file-system reads. If a finding mentions a race / TOCTOU / deadlock, it must point to one of these — not to two synchronous methods that touch the same object.
- **Single-user CLI process.** One TTY, one user, one in-memory state. There are no concurrent requests, no other tenants, no shared mutable state across processes. Patterns from server/web contexts (request-scoping, multi-tenant isolation, lock contention) generally do not apply.
- **Effect-TS pipelines compose deterministically.** Sequential `Effect.gen` blocks run in declared order. `Effect.ensuring` cleanup runs in FILO scope order. If a finding requires two `Effect`s to interleave non-deterministically, the code must explicitly use a parallel combinator — verify before claiming.

### Trust boundaries — read before flagging "missing validation" or "missing type guards"

- **Boundaries where runtime validation belongs**: user keystrokes (the chat prompt), files read from disk, JSON parsed from LLM provider HTTP responses, MCP tool call inputs/results, env vars, CLI args, anything crossing process boundaries.
- **Where TypeScript is the contract**: data flowing between modules in this codebase. State produced by a pure reducer in one file and consumed by the same module's hook in another file is type-checked. Adding a `isFoo(x)` guard there is dead code; suggest it only at an actual boundary.
- **Effect Schema** (`@effect/schema`) is the validation tool of choice when you do need runtime validation at a boundary. Don't recommend it for module-internal types.

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
- ❌ **DON'T invent concerns to fill the output** - An empty `[]` is correct when nothing is wrong. If you find yourself reaching for a concern, that's the signal to stop, not to push harder.

**Tests every comment must pass before you emit it:**

1. **Concrete-line test.** Can you cite the exact line(s) and the exact failure mode? "This *could* break under X, *might* race, *may* fail" without a specific input or call sequence is not a finding — it's a hunch. Drop it.
2. **Verify-before-claim test.** Before flagging that the code is missing X (a check, a type, a test, a primitive), confirm by reading the code that X is actually missing. Many false positives come from pattern-matching on the *shape* of the code without reading what it does.
3. **Contract test.** A function should be evaluated against the contract it states (in its name, JSDoc, types, and call sites) — not against extensions you imagine. If the function doesn't claim to handle a case, missing tests for that case is not a defect.
4. **Runtime-model test.** When flagging a class of bug ("race", "leak", "deadlock", "unhandled rejection"), the runtime must actually permit it. JS is single-threaded; synchronous functions can't preempt. Effect-TS pipelines compose deterministically. Verify the bug class is reachable in *this* runtime before naming it.
5. **Framework-recommendation test.** Don't propose adopting a framework or pattern (Effect, Schema, type guards, dependency injection) as a generic "this would be safer" — only when there's a concrete reason rooted in this specific code that the existing approach fails to handle.

If a comment doesn't pass all five, drop it. Volume is not the goal; signal is.

**When in doubt**: Read the surrounding code and project files. If after reading you still can't articulate the specific failure mode, the comment isn't ready.

## Output Format

Your output has **two mandatory blocks**, in this order:

1. A **`````markdown`** summary block — always required, never empty
2. A **`````json`** inline-comments block — always required, may be `[]`

### Block 1 — Markdown summary (always required)

Write a human-readable review summary. This is posted as the top-level PR comment regardless of whether inline comments exist. It must never be empty.

Include:
- Which files you reviewed (a brief list or count)
- Overall verdict: what looks good, what was changed and why it's correct, or what issues were found
- If no inline issues: say so clearly and briefly explain what you checked

### Block 2 — Inline comments (always required, may be `[]`)

A JSON array of per-line review comments. Use `[]` when there are no inline findings — but Block 1 must still explain the review.

**Four-backtick rule for both blocks.** Three backticks will corrupt your output: `body` fields routinely contain triple-backtick code samples, and a triple-backtick outer fence collides with them. Use four backticks for both outer wrappers.

| ✅ DO | ❌ DON'T |
|---|---|
| `` ` ` ` ` markdown `` …summary… `` ` ` ` ` `` then `` ` ` ` ` json `` …array… `` ` ` ` ` `` | `` ` ` ` json `` …3 backticks… `` ` ` ` `` |
| Inner code fences inside `body` use **three** backticks | Output anything after the closing JSON fence |

When flagging issues, suggest concrete edits (code snippets or exact changes) when possible.

### Example (issues found)

````markdown
Reviewed 3 files. Found 2 issues: one null-dereference in `src/example.ts` and a suggestion in `src/utils.ts`.
````

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

### Example (no issues)

````markdown
Reviewed 5 files (`src/cli/ui/store.ts`, `src/services/chat-service.ts`, and 3 others).

Changes look correct: the `resetRunStats` call properly clears stale session data, the queue injection follows the existing tool-call loop pattern, and the AI SDK promise suppression is well-scoped to the error path only. No logic errors, type gaps, or edge cases missed.
````

````json
[]
````

### Self-check before emitting

1. Did you emit a `````markdown` block first? It must be non-empty.
2. Did you emit a `````json` block second? The array may be `[]` but the block must be present.
3. Both outer fences use **four** backticks. Count them.
4. Inner code fences inside `body` use **three** backticks.
5. Nothing after the closing JSON fence.

### Inline comment field rules

- `path`: relative file path from repo root (must exist in the diff)
- `line`: line number; use the NEW version (RIGHT side) for added/modified files, or the OLD version (LEFT side) for deleted files
- `start_line`: (optional) start line for multi-line block comments; omit for single-line
- `side`: "RIGHT" for added/modified files; "LEFT" for deleted files
- `body`: markdown — include severity (Critical/Suggestion/Nice-to-have), explanation, and a concrete fix when possible

**CRITICAL — Line number accuracy:**

The `line` field MUST reference a line that actually appears in the diff output. The GitHub API will reject comments on lines outside the diff hunks.

1. **Verify the line is in the diff** — only comment on lines visible in `git_diff` output.
2. **Do NOT guess or extrapolate line numbers** — if the relevant code is not in the diff, attach the comment to the nearest valid diff line.
3. **Prefer changed lines** — lines prefixed with `+` in the diff are always valid targets.
4. **Context lines are also valid** — unchanged lines shown in the diff hunk can be commented on.
5. **Lines outside the diff are NOT valid** — they cause a "Line could not be resolved" API error.
