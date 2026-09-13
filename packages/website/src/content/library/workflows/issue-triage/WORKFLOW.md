---
name: issue-triage
description: New GitHub issues since the last run, each with a suggested label, a likely duplicate, and whether it has enough to reproduce.
schedule: "0 9 * * 1-5"
autoApprove: read-only
maxIterations: 40
maxCostUSD: 0.75
author: jazz
tags: [github, issues, triage]
---

# Issue triage

Triage the issues opened in this repository. Read only: suggest, do not label, comment, or close.

## Window

Issues created after `{schedule.lastRunAt}`. If that is empty, the last 7 days.

## Gather

1. `gh issue list --state open --limit 100 --json number,title,body,labels,author,createdAt,url`
   and keep those inside the window.
2. `gh label list --json name,description` so suggestions use labels that exist.
3. For each new issue, search for a likely duplicate among open and recently closed issues:
   `gh issue list --state all --limit 50 --search "<three distinctive words from the title>"`.

## Judge each issue

- **Kind**: bug, feature request, question, or unclear.
- **Reproducible**: for a bug, does it name a version, the steps, and what happened instead of
  what was expected? If not, name the one missing piece.
- **Duplicate of**: the most similar existing issue, or none.
- **Label**: one or two from the repository's own list.

## Report

A table with one row per issue: number as a link, title, kind, label suggestion, duplicate
candidate, and "ready" or the missing piece. Below it, a **Reply first** list of at most three
issues that a maintainer should answer today and why.
