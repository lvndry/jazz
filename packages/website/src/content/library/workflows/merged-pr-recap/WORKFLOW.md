---
name: merged-pr-recap
description: Recap every pull request merged since this schedule last ran. Weekly for the team channel, monthly for the wider update, from one file.
schedule: "0 17 * * 5"
autoApprove: read-only
maxIterations: 40
maxCostUSD: 1.00
author: jazz
tags: [git, github, review, engineering]
---

# Merged pull requests recap

Write the `{schedule.label}` recap of what landed in this repository. Read only; change nothing.

## Window

Cover pull requests merged after `{schedule.lastRunAt}` and before `{run.startedAt}`. If the
start is empty this schedule has never run: use the last seven days for a weekly recap and the
last month otherwise, and say which window you used.

## Gather

1. `gh pr list --state merged --search "merged:>YYYY-MM-DD" --limit 200 --json number,title,author,mergedAt,labels,url`
   with the window start as the date. Without `gh`, fall back to
   `git log --merges --since="<window start>" --format="%h %s"`.
2. For anything that touched public surface (CLI flags, config, HTTP routes, exported types), read
   the diff with `gh pr diff <number>` and note whether docs changed with it.
3. Group the pull requests by theme, not by author.

## Report

Reply with one Markdown document:

1. **Headline**: one sentence a teammate who missed everything should still read.
2. **Landed**: one bullet per theme, each naming its pull requests as `#123` links and the people
   who shipped them.
3. **Watch out for**: behaviour changes with no test, public surface with no docs update, and
   anything reverted. "None." is a fine answer.
4. **By the numbers**: pull requests merged, contributors, and the window covered.

For the monthly recap, add a short **Themes of the month** paragraph before the bullets. Keep the
weekly one to what fits on a phone screen.
