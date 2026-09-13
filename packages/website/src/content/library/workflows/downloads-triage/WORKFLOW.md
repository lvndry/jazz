---
name: downloads-triage
description: What piled up in Downloads this week, with a keep-or-delete verdict on each and the commands to act on it.
schedule: "0 18 * * 0"
autoApprove: read-only
maxIterations: 25
maxCostUSD: 0.30
author: jazz
tags: [files, cleanup, personal]
---

# Downloads triage

Go through `~/Downloads` and tell me what can go. Read only: suggest, never delete. Sorting
files into folders is `desktop-tidy`'s job; this one decides what should not exist at all.

## Look

List every file, not folder, with size, modification date, and on macOS the last-opened date from
`mdls -name kMDItemLastUsedDate <file>`. Skip files modified after `{schedule.lastRunAt}` only if
that is less than a day ago; otherwise include everything.

## Verdicts

- **Delete**: installers whose app is already in `/Applications`; duplicates with the same
  content (`shasum` on files with equal sizes) keeping the newest; browser leftovers such as
  `.crdownload`, `.part`, and `(1)`-suffixed copies of a file that still exists; archives whose
  extracted folder sits next to them.
- **Probably delete**: not opened in 60 days and under 1 MB, or a PDF whose name looks like a
  receipt or ticket for a date that has passed.
- **Keep**: opened this month, or larger than 100 MB and opened this quarter, or anything you
  cannot tell.
- **Ask**: everything else, with one line on why you are unsure.

## Report

Four sections in that order, each a compact list with file name, size, and the one-word reason.
Under **Delete**, add a fenced block of `rm` commands, one per line, using full paths, ready to
paste. Never include a folder or a `-r` flag.

End with one line: total size in each verdict, so I can see what deleting buys me.
