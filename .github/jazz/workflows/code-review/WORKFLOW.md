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
- `line`: line number in the NEW version of the file (RIGHT side of the diff); end line for multi-line blocks
- `start_line`: (optional) start line for multi-line block comments; omit for single-line
- `side`: always "RIGHT" (comment on the new code)
- `body`: markdown comment — include severity (Critical/Suggestion/Nice-to-have), explanation, and a concrete fix when possible

If there are no issues, output an empty array: `[]`
