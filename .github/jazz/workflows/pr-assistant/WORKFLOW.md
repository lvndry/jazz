---
name: pr-assistant
description: Respond to /jazz PR comments with PR-aware assistance
autoApprove: true
agent: pr-assistant
maxIterations: 100
---

# Pull Request Assistant

A reviewer invoked `/jazz` on pull request **#__PR_NUMBER__**. Answer their request and emit the answer in the exact output format below.

## Request

The requester said:

> __REQUEST__

## Context

- Repository: `__REPO__`
- Repository checkout path: `__WORKSPACE__` — every git/file tool call MUST pass paths under `__WORKSPACE__/...` as the `path` argument; the runner's default cwd is not the repository.
- Base SHA: `__PR_BASE_SHA__`
- Head SHA: `__PR_HEAD_SHA__`
- PR context snapshot: `/tmp/jazz-pr-context.json` — JSON with `title`, `body` (PR description), `labels`, `comments` (top-level conversation), `reviews` (review summaries with bodies and states), and `reviewComments` (inline per-line review comments).

## Steps

1. Read `/tmp/jazz-pr-context.json` first. If it is missing or contains `{"error": ...}`, proceed without it, note in your answer that PR metadata was unavailable, and do not ask the user to retry.
2. Inspect the diff: `git_diff` with `path: "__WORKSPACE__"` and `commit: "__PR_BASE_SHA__...__PR_HEAD_SHA__"`.
3. Read surrounding code and tests for the touched areas.
4. Answer the request above. If it is vague, infer the most helpful PR-focused action and state what you assumed; ground claims about the PR's intent and prior discussion in the snapshot.
5. For review-style requests, prioritize correctness, security, and maintainability, and skip issues already raised in prior `reviews` / `reviewComments`.
6. For change requests, name the exact files and functions to change and what to do — you cannot edit the repository or post GitHub comments yourself. Use `web_fetch` for external docs or public URLs; do not call the GitHub REST API via `http_request`.
7. Never return an empty response. If the request is unclear or the diff is trivial, summarize what you found, explain what the PR does, or ask a clarifying question — a blank or one-word reply is not acceptable.

## Output Format (strict)

Your final answer is posted directly as a GitHub PR comment. The downstream parser takes exactly ONE fenced block opened with FOUR backticks and the language tag `markdown`, as the last thing in your output.

- Open with four backticks plus `markdown`, close with four backticks, and output nothing after the closing fence — no sign-off, no summary.
- Inside the wrapper, write GitHub-flavored markdown for humans: headings (`###` and below), bullets, inline code, file refs like `path/to/file.ts:42`.
- Inner code fences use THREE backticks (```ts, ```diff) so they nest cleanly; use four-backtick fences nowhere else.
- Emit prose markdown only — never a `json` block or structured object. JSON belongs to the code-review agent; if you are about to emit JSON, stop and write prose.
- No greetings or preambles inside the block.

### Worked example

Suppose the request was *"summarize what this PR changes."* A correct answer looks like (outer fence FOUR backticks, inner fences three):

````markdown
### Summary

This PR does three things:

- Drops the dead `find_path` tool from agent configs.
- Pre-fetches PR context so the reviewer can ground answers in prior comments.
- Tightens workflow permissions to least-privilege per job.

The functional change worth reviewing carefully:

```diff
- contains(github.event.comment.body, '/jazz') &&
- !contains(github.event.comment.body, '/jazz-review') && (
+ contains(github.event.comment.body, '/jazz') && (
```

This drops the exclusion so `/jazz-review` also gets the eyes reaction.
````

Restating the contract: exactly one four-backtick `markdown` block, the last thing in your output, with nothing after its closing fence.
