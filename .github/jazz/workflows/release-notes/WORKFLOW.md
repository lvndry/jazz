---
name: release-notes
description: Generate release notes by analyzing commits between git tags
autoApprove: true
agent: release-notes
maxIterations: 100
---

# Release Notes Generation

Generate release notes for **__NEW_TAG__** from the commits since **__PREVIOUS_TAG__**, and emit them in the exact output format below.

## Context

- Repository checkout path: `__WORKSPACE__` — every git/file tool call MUST pass this as the `path` argument; the runner's default cwd is not the repository.

## Steps

1. Run `git_log` with `path: "__WORKSPACE__"` to get all commits between `__PREVIOUS_TAG__` and `__NEW_TAG__`.
2. Run `git_diff` with `path: "__WORKSPACE__"` and `commit: "__PREVIOUS_TAG__...__NEW_TAG__"` to understand the scope. If the diff is large, narrow it with the `paths` parameter (an array of file paths, e.g. `paths: ["src/foo.ts", "src/bar.ts"]`).
3. Read source files under `__WORKSPACE__/...` where a commit's purpose is unclear.
4. Group commits by feature/product area (e.g. "Agent workflows", "CLI experience", "Scheduler") — one group per cohesive capability, never by change type (Features, Bug Fixes).
5. Write funny, exciting, product- and UX-focused descriptions: what changed, what problem it solves, and why users should care. Reference PR numbers when available.
6. Skip trivial commits (version bumps, merge commits).

## Output Format (strict)

The very last thing you output MUST be a single fenced block opened with FOUR backticks and the tag `markdown`, closed with four backticks, with nothing after it. Three backticks would collide with inner ```ts / ```diff samples and truncate the notes mid-sentence; inner code fences use three backticks and nest cleanly.

The block's content follows this structure:

````markdown
## What's Changed

### [Feature Group Name]
Exciting, funny, product-focused description of what shipped and why users should care. Focus on value and UX.

### [Another Feature Group]
Same vibe — what changed, what problem it solves, why it's awesome.

---

## Commits

- `abc1234` Commit message by @user
- `def5678` Another commit message by @user

## Full diff

[__PREVIOUS_TAG__...__NEW_TAG__](https://github.com/__REPO__/compare/__PREVIOUS_TAG__...__NEW_TAG__)
````

Each section header is a feature name and its paragraph sells the value. Always close the notes with the full commit list and the diff link (`__REPO__` is substituted with owner/repo, e.g. `lvndry/jazz`).

Restating the contract: one four-backtick `markdown` block, the last thing in your output, with nothing after its closing fence.
