---
name: code-review
description: Review pull request changes for quality, security, and correctness
autoApprove: true
agent: ci-reviewer
maxIterations: 100
---

# Pull Request Code Review

Review this pull request's diff for real issues — behavior regressions, correctness bugs, security risks, and silent error-handling failures — and emit exactly the two-block output defined under Output Format. Returning `[]` for a sound diff is a correct result; a short accurate review beats many weak comments.

## Context

- Repository checkout: `__WORKSPACE__` — every `read_file`, `ls`, `find`, `grep`, and git tool call must use paths under `__WORKSPACE__/...`.
- Diff range: `__PR_BASE_SHA__...__PR_HEAD_SHA__`
- PR metadata snapshot: `/tmp/jazz-pr-context.json` — may include title, body, labels, comments, review summaries, and prior inline review comments. If it is missing or contains `{"error": ...}`, continue the review without it.

## Runtime Model (calibrate every finding against this)

Jazz is a single-user agentic CLI running on local or server machines, not a multi-tenant web service.

- Single-threaded JS runtime: no race conditions in purely synchronous code. Real concurrency exists only at `await` boundaries, `Promise.all`, Effect parallel combinators, and external I/O.
- Trust boundaries: CLI args, env vars, filesystem, network payloads, MCP/tool input and output, and LLM output. Check for prompt injection, command/path injection, secret exposure, and unsafe tool-execution paths.
- Performance: flag avoidable CPU-heavy loops, excessive allocations, unbounded growth, and memory retention that would degrade CLI workflows.

## Steps

1. Read `/tmp/jazz-pr-context.json` to extract the intended behavior and the issues already raised.
2. Run `git_diff` with `nameOnly: true` to list changed files — this list is authoritative for the PR's scope. Then call `git_diff` (without `maxLines`) to read the full diff — it returns the entire diff by default. If you ever see `truncated: true` (only happens when a call is deliberately capped), re-fetch without the cap or scope with `paths: [...]`. The number of files you review must match the `nameOnly` list.
3. For every changed file, open the surrounding code and read the call sites of each changed export or function — a change is only correct if its callers still hold. Never judge a diff hunk in isolation; trace it to who depends on it, and verify contracts at call sites and boundary interfaces.
4. Check intent vs behavior: does the implementation do what the PR claims, on both success and failure paths? Could it degrade real CLI/agent usage?
5. Check engineering quality: strict TypeScript with no avoidable `any`; Effect-TS typed/tagged errors, proper Layer boundaries, explicit parallelism, scoped resources; validation at trust boundaries; actionable errors with no silent drops; no brittle coupling or hidden side effects.
6. De-duplicate and calibrate: drop findings already clearly raised in prior review comments (unless unresolved and still critical) and drop anything without a concrete, reachable failure mode.
7. Cover the whole PR — every file in the step-2 list, not a sample. For a large PR (10+ files or 500+ changed lines) you MUST spawn subagents, each owning a batch of files and each responsible for (a) reading the full diff for its files, (b) reading the call sites of the changed exports, and (c) returning findings — then merge them into one output. Never conclude the review after inspecting only a subset of the changed files.

A valid finding names the exact file and diff line(s), what fails at runtime, why it fails, and a concrete fix direction (or a patch snippet when obvious). "This might be unsafe" without a realistic path, "consider pattern X" without a demonstrated deficiency, and style or formatting preferences are not findings.

## Output Format (strict)

Your output must contain exactly two fenced blocks, in this order, with no text before, between, or after them. Both outer fences use FOUR backticks so triple-backtick snippets inside `body` nest cleanly.

1. A four-backtick `markdown` block — the review verdict, never empty. This is a verdict, not a PR summary: state how many of the changed files you reviewed (this count must equal the number of files from step 2 — if it does not, you have not finished), what you found or a clear "looks sound" conclusion, and what you checked to reach it.
2. A four-backtick `json` block — an array of inline comments, `[]` when there are none. Each object:
   - `path`: repo-relative file path in the diff
   - `line`: target line from the diff
   - `start_line`: optional, for ranges
   - `side`: `RIGHT` for added/modified lines, `LEFT` for deleted
   - `body`: markdown with severity, explanation, and fix guidance

### Inline comment line accuracy (GitHub rejects comments on lines outside diff hunks)

1. Confirm every `line` exists in a diff hunk before emitting it.
2. Prefer commenting on changed (`+`) lines.
3. If the relevant code is outside the hunks, attach the comment to the nearest valid hunk line and explain the context in `body`.

### Example (issues found)

````markdown
Reviewed 4 files. Found 2 concrete issues: one behavior regression in command error recovery and one unsafe path handling case.
````

````json
[
  {
    "path": "src/example.ts",
    "line": 42,
    "side": "RIGHT",
    "body": "**Critical**: This can throw when `user` is null in the retry path.\n\nSuggested fix:\n```ts\nif (!user) return Effect.fail(new InvalidStateError())\n```"
  }
]
````

### Example (no issues)

````markdown
Reviewed 6 files. The diff is behaviorally consistent with the stated intent, keeps Effect error channels explicit, and preserves CLI failure semantics. I checked changed call sites, boundary validation points, and edge-path cleanup. No concrete correctness or security issues found.
````

````json
[]
````

Before emitting, confirm: every comment names concrete diff lines and a concrete failure mode; exactly two blocks in order `markdown` then `json`; both outer fences are four backticks; nothing follows the closing `json` fence.
