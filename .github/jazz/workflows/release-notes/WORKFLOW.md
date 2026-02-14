---
name: release-notes
description: Generate release notes by analyzing commits between git tags
autoApprove: true
agent: release-notes
maxIterations: 100
---

# Release Notes Generation

Generate release notes for **__NEW_TAG__** by comparing commits since **__PREVIOUS_TAG__**.

## Steps

1. Use `git_log` to get all commits between `__PREVIOUS_TAG__` and `__NEW_TAG__`.
2. Use `git_diff` with `commit` set to `__PREVIOUS_TAG__...__NEW_TAG__` to understand the scope of changes. If the diff is large, scope to individual files using the `path` parameter.
3. Read relevant source files to understand the context of changes.
4. Group commits by **feature** — cluster related changes into cohesive product areas (e.g. "Agent workflows", "CLI experience", "Scheduler"). Each group = one feature or capability area.
5. Write **funny, exciting, product- and UX-focused** descriptions. Explain what changed and **why it matters** to the user. No dry dev-speak — make it feel alive and clear.
6. Skip trivial commits (version bump, merge commit).

## Output Format

You MUST output a single markdown fenced code block (use FOUR backticks) as the very last thing you write. Do NOT output anything after it.

The content inside the block should follow this structure:

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

Rules:
- Group by **feature/product area**, not by type (Features, Bug Fixes, etc.).
- Tone: funny, exciting, clear — product and UX first.
- Each section header is the feature name; the paragraph sells the value.
- Include the full commit list at the bottom.
- Always include the diff link (__REPO__ is substituted with owner/repo, e.g. `lvndry/jazz`).
- Reference PR numbers in descriptions when available.
