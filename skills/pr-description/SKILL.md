---
name: pr-description
description: Generate pull request titles and descriptions from diffs and context. Use when creating a PR, writing PR description, drafting merge request, or summarizing changes for review.
---

# PR Description

Generate clear, structured pull request titles and descriptions from git diff, branch context, and linked issues.

## When to Use

- User is about to open a PR or merge request
- User asks for a PR description, title, or summary of changes
- User wants to document what a branch does for reviewers

## Workflow

1. **Gather context**: Current branch, base branch, `git diff`, `git log`, commit messages
2. **Identify scope**: Files changed, types of change (feature, fix, refactor, docs)
3. **Check for issues**: Linked issue numbers in branch name or commits
4. **Draft title**: Short, imperative, conventional (e.g. `feat(auth): add OAuth2 login`)
5. **Draft description**: Summary, what changed, why, how to test, checklist

## Title Format

Prefer conventional commits style:

```
<type>(<scope>): <short description>

Types: feat, fix, docs, style, refactor, test, chore
Scope: optional, e.g. auth, api, ui
```

Examples:
- `feat(auth): add Google OAuth2 login`
- `fix(api): handle null in user lookup`
- `docs: update README installation steps`
- `refactor(store): migrate to Zustand`

Keep under 72 characters. No period at end.

## Description Template

```markdown
## Summary
[1-3 sentences: what this PR does and why]

## Changes
- [Key change 1]
- [Key change 2]
- [Key change 3]

## Related
- Fixes #123
- Relates to #456

## How to Test
1. [Step 1]
2. [Step 2]

## Checklist
- [ ] Tests added/updated
- [ ] Docs updated
- [ ] No breaking changes (or listed in description)
```

## What to Include

**Always**:
- Summary that explains intent, not just file names
- List of meaningful changes (not every file)
- How to test (steps or "manual: ...")
- Related issue if any

**When relevant**:
- Breaking changes section
- Screenshots for UI changes
- Migration notes for DB/schema changes
- Performance or security notes

**Avoid**:
- Copy-pasting full diff into description
- Vague summaries ("updated stuff")
- Missing test instructions for non-trivial changes

## Gathering Context

```bash
# Branch and diff
git branch --show-current
git log main..HEAD --oneline
git diff main...HEAD --stat
git diff main...HEAD  # full diff for analysis

# Linked issues (from branch name or commits)
git log main..HEAD --oneline | grep -oE '#[0-9]+'
```

Infer scope from changed paths (e.g. `src/auth/` → scope "auth"). Use commit messages to reinforce intent.

## Tone

- Neutral and factual
- Reviewer-friendly: make it easy to understand scope and how to verify
- No marketing speak; no "This amazing PR adds..."

## Anti-Patterns

- ❌ Title that repeats ticket number only ("JIRA-123")
- ❌ Description that is only "See commits"
- ❌ No testing steps for behavior changes
- ❌ Huge bullet list of every file touched
