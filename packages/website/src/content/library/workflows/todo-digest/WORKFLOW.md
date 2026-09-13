---
name: todo-digest
description: The TODO and FIXME comments added since the last digest, grouped by area, with the oldest ones surfaced.
schedule: "0 10 * * 5"
autoApprove: read-only
maxIterations: 25
maxCostUSD: 0.30
author: jazz
tags: [code-quality, git, engineering]
---

# TODO digest

Report on the TODO, FIXME, HACK, and XXX comments in this repository. Read only.

## Window

Cover changes after `{schedule.lastRunAt}`. If that is empty, cover the last 30 days and say so.

## Gather

1. New markers: `git log --since="<window start>" -p -G'(TODO|FIXME|HACK|XXX)' --format='%h %an %ad' -- . ':!node_modules' ':!dist'`
   and keep only added lines (`+`) containing a marker.
2. Everything currently present: `grep -rnE '(TODO|FIXME|HACK|XXX)' --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git .`
3. Age of each existing marker: `git blame -L <line>,<line> --porcelain <file>` for the ten
   oldest-looking ones only; do not blame every line.

## Report

1. **Added this window**: grouped by top-level directory, each with file, line, author, and the
   comment text. Say who added the most.
2. **Oldest still open**: the ten oldest markers with their age in months. These are the ones
   nobody is coming back for.
3. **FIXME and HACK**: list separately from TODO, since they describe known-wrong code.
4. **Totals**: markers now versus at the start of the window.

Keep each comment to one line. Do not propose fixes.
