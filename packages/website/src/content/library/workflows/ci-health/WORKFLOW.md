---
name: ci-health
description: A daily look at failed and slow GitHub Actions runs, with the flaky jobs called out by name.
schedule: "0 8 * * 1-5"
autoApprove: read-only
maxIterations: 30
maxCostUSD: 0.50
author: jazz
tags: [ci, github, engineering]
---

# CI health

Report on this repository's GitHub Actions runs. Read only; do not re-run or cancel anything.

## Window

Runs created after `{schedule.lastRunAt}`. If that is empty, the last 24 hours.

## Gather

1. `gh run list --limit 200 --json databaseId,name,status,conclusion,event,headBranch,createdAt,updatedAt,url`
   and keep the runs inside the window.
2. For each failed run on the default branch, `gh run view <id> --log-failed | tail -60` and pull
   out the first real error line, not the framework noise around it.
3. A job is **flaky** when the same workflow failed and then passed on the same commit, or failed
   with an error unrelated to the diff (network, timeout, rate limit).

## Report

1. **Red on the default branch**: each failed run with branch, workflow, the error line, and a
   link. If there are none, say so in one line and skip to slow runs.
2. **Flaky**: workflow and job names that failed then passed, with the count. These cost more
   than real failures because people stop trusting the signal.
3. **Slow**: the three longest runs in the window, with their duration and the median for that
   workflow, so a regression stands out from a workflow that is always slow.
4. **Pass rate**: runs passed over runs finished, for the default branch and for pull requests
   separately.
