---
name: daily-standup-prep
description: Turn the commits since the last standup note and today's work in progress into a three-line standup.
schedule: "0 9 * * 1-5"
autoApprove: read-only
maxIterations: 20
maxCostUSD: 0.25
author: jazz
tags: [standup, git, engineering]
---

# Standup prep

Prepare my standup note for this repository. Read only; change nothing.

## Yesterday

Cover my commits since `{schedule.lastRunAt}`, or since yesterday morning if that is empty:
`git log --since="<start>" --author="$(git config user.name)" --oneline`. Group them by the
feature or fix they belong to. One line per group, in plain language, not commit-message language.

## Today

Look at the current branch: its name, uncommitted changes from `git status --short`, and any
`TODO` or `FIXME` added in `git diff` since the branch left `main`. From that, name the one or two
things most likely to happen today.

## Blockers

Mention only what the repository shows: a failing test in the last commit message, a merge conflict,
a dependency that will not install. If nothing shows, write "None visible from the repo."

## Output

Exactly this shape, ready to paste into chat:

```
Yesterday: ...
Today: ...
Blockers: ...
```
