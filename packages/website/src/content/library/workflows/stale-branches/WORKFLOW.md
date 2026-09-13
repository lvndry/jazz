---
name: stale-branches
description: Weekly report of branches nobody has touched in a month, and merged branches still lying around.
schedule: "0 9 * * 1"
autoApprove: read-only
maxIterations: 25
maxCostUSD: 0.30
author: jazz
tags: [git, hygiene, engineering]
---

# Stale branches

Report on branch hygiene for this repository. Read only; never delete or push.

## Gather

1. `git fetch --prune --dry-run` to see what the remote already dropped, then
   `git for-each-ref --sort=committerdate refs/remotes/origin --format='%(refname:short) %(committerdate:iso8601) %(authorname)'`.
2. `git branch -r --merged origin/main` for branches already merged into the default branch.
   If the default branch is not `main`, use `git symbolic-ref refs/remotes/origin/HEAD`.
3. For each branch older than 30 days, check whether an open pull request references it:
   `gh pr list --head <branch> --state open --json number,title` when `gh` is available.

## Report

1. **Safe to delete**: merged into the default branch, no open pull request. One line each with
   the author and the merge date.
2. **Abandoned?**: unmerged, no commits in 30 days, no open pull request. Group by author so each
   person gets one short list to answer.
3. **Long-lived with an open PR**: unmerged, older than 30 days, but a pull request exists. Name
   the PR; these are review debt, not garbage.
4. **Totals**: branches, stale branches, and the oldest one.

Suggest the exact `git push origin --delete <branch>` commands for section 1 as a fenced block,
but do not run them.
