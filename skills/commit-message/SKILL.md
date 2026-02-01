---
name: commit-message
description: Suggest conventional commit messages from diff and context. Use when committing changes, writing commit message, or summarizing staged changes.
---

# Commit Message

Suggest clear, conventional commit messages from git diff, staged changes, and context.

## When to Use

- User is about to commit and asks for a message
- User wants to summarize staged or unstaged changes
- User asks "what commit message should I use?"

## Workflow

1. **Inspect changes**: `git diff --staged` (or `git diff` if nothing staged)
2. **Identify type**: feat, fix, docs, style, refactor, test, chore
3. **Identify scope**: optional, e.g. auth, api, ui
4. **Summarize**: Short imperative description
5. **Optional body**: Why and what, if non-obvious
6. **Optional footer**: Fixes #N, Breaking change

## Conventional Commit Format

```
<type>(<scope>): <short description>

[optional body]

[optional footer]
```

### Types

| Type         | When to use                             |
| ------------ | --------------------------------------- |
| **feat**     | New feature or capability               |
| **fix**      | Bug fix                                 |
| **docs**     | Documentation only                      |
| **style**    | Formatting, whitespace, no logic change |
| **refactor** | Code change that isn't fix or feat      |
| **test**     | Adding or updating tests                |
| **chore**    | Build, tooling, deps, config            |
| **perf**     | Performance improvement                 |

### Scope (optional)

- Package, module, or area: `auth`, `api`, `ui`, `cli`
- Infer from changed paths: `src/auth/` → scope `auth`

### Short description

- Imperative, lowercase, no period: "add login" not "added login"
- Under ~50 chars for subject line
- What changed, not why (why can go in body)

## Examples

From diff that adds OAuth login:
```
feat(auth): add OAuth2 login
```

From diff that fixes null in user lookup:
```
fix(api): handle null in user lookup
```

From diff that only touches README:
```
docs: update README installation steps
```

From diff that refactors store without changing behavior:
```
refactor(store): extract user selectors
```

From diff that upgrades deps:
```
chore(deps): upgrade react to 18.2
```

## Body (optional)

Use when:
- Why isn't obvious from the diff
- Breaking change
- Non-trivial rationale

```text
feat(api): add pagination to list endpoint

BREAKING CHANGE: list endpoint now returns { items, nextCursor } instead of a plain array.
```

## Footer (optional)

- `Fixes #123` or `Closes #123` for issues
- `Breaking change: ...` for breaking changes

## Gathering Context

```bash
# Staged changes (preferred)
git diff --staged --stat
git diff --staged

# Unstaged if nothing staged
git diff --stat
git diff

# Recent commits for style
git log -3 --oneline
```

Infer type and scope from:
- File paths (e.g. `src/auth/`, `docs/`)
- Content (new function vs rename vs delete)
- Test files → type `test` or mention in body

## Multiple Logical Changes

If staged changes mix multiple concerns:
- Suggest splitting: "Consider committing in 2 commits: 1) feat(auth): ... 2) docs: ..."
- Or suggest one message that covers the main theme and note "includes X and Y" in body

## Tone

- Neutral and factual
- Imperative mood ("add" not "added")
- No emoji or hype in the message unless project convention uses them

## Anti-Patterns

- ❌ "fix stuff", "update", "WIP"
- ❌ Past tense ("fixed bug")
- ❌ Period at end of subject
- ❌ Very long subject line (wrap in body instead)
