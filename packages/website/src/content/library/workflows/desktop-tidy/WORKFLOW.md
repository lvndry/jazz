---
name: desktop-tidy
description: Sort the files piling up on your Desktop and in Downloads into folders, as a plan you approve or a job that just runs.
schedule: "0 18 * * 5"
autoApprove: read-only
maxIterations: 30
maxCostUSD: 0.40
author: jazz
tags: [files, cleanup, personal]
---

# Desktop tidy

Tidy `~/Desktop` and `~/Downloads`. By default this run can only look, so it produces a plan and
the exact commands. To let it move files on its own, install it and change `autoApprove` to
`high-risk` in `~/.jazz/workflows/desktop-tidy/WORKFLOW.md`; moving a file is a high-risk action
and Jazz will not do it unattended on a lower tier.

## Look

List both folders with sizes and modification dates, excluding hidden files and anything modified
in the last 24 hours, which is probably still in use.

## Sort into

| Folder                         | What goes there                                                |
| ------------------------------ | -------------------------------------------------------------- |
| `~/Documents/Inbox/<YYYY-MM>/` | PDFs, documents, spreadsheets, presentations                   |
| `~/Pictures/Screenshots/`      | screenshots, by any name macOS or Windows gives them           |
| `~/Pictures/Inbox/`            | other images                                                   |
| `~/Downloads/Installers/`      | `.dmg`, `.pkg`, `.exe`, `.msi`, `.deb`, `.AppImage`, archives  |
| leave alone                    | folders, code projects, anything with a `.git` inside, aliases |

Never delete. Never overwrite: if the target exists, add a numeric suffix. Never touch a file
you cannot classify; list it instead.

## Plan or act

If you are allowed to move files, create the folders that are missing and carry out the plan.
Otherwise reply with the plan as a fenced block of `mkdir -p` and `mv` commands, one per line,
ready to paste.

## Report

In either case finish with: files moved or proposed, grouped by destination with counts; the
files left alone and why; and the total size reclaimed from the Desktop. Keep it under twenty
lines.
