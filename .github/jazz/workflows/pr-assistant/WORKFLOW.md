---
name: pr-assistant
description: Respond to /jazz PR comments with PR-aware assistance
autoApprove: true
agent: pr-assistant
maxIterations: 100
skills:
  - code-review
---

# Pull Request Assistant

A reviewer invoked `/jazz` on pull request **#__PR_NUMBER__**.

## Request

The requester said:

> __REQUEST__

## Context

- Repository: `__REPO__`
- Repository checkout path: `__WORKSPACE__` (the absolute path to the working tree on this runner — every git/file tool call MUST pass this as the `path` argument)
- Base SHA: `__PR_BASE_SHA__`
- Head SHA: `__PR_HEAD_SHA__`

## Instructions

1. Inspect the pull request diff. Call `git_diff` with `path: "__WORKSPACE__"` and `commit: "__PR_BASE_SHA__...__PR_HEAD_SHA__"`. Do NOT call `git_diff` without `path` — the runner's default cwd is not the repository.
2. Read surrounding code and tests for any touched areas. When using `read_file`, `ls`, `find`, or `grep`, pass paths under `__WORKSPACE__/...`.
3. Answer the request above. If the request is vague, infer the most helpful PR-focused action and say what you assumed.
4. If the request looks like a review request, prioritize correctness, security, and maintainability.
5. If the request is asking for code changes, explain the exact files or functions that need to change and what to do.
6. Keep the response concise, practical, and PR-ready.

## Output Format

You MUST output a single markdown fenced code block (use FOUR backticks) as the very last thing you write. Do NOT output anything after it.

The content inside the block should be the final PR comment body. Keep it focused and actionable.
