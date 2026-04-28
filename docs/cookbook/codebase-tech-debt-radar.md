# codebase-tech-debt-radar

**What it does:** Once a week, walks one or more local repos, counts and categorizes `TODO` / `FIXME` / `HACK` / `XXX` markers, and writes a trend report so you can see whether tech debt is growing or shrinking.
**Schedule:** `0 18 * * 5` — 18:00 every Friday (end of week).
**Risk:** `read-only` — only `grep`, `git log`, and a single `write_file` to a scratch dir.
**Tools used:** `grep`, `find`, `git_log`, `read_file`, `write_file`.

## Why this is useful

You either ship a tech-debt jira queue nobody touches, or you stay blind to the trend. This recipe gives you a 30-second weekly snapshot: how many markers, where, and whether the line is going up or down. That's enough signal to bring up at retro without a full audit.

## The workflow file

```markdown
---
name: codebase-tech-debt-radar
description: Weekly FIXME/TODO/HACK trend report across selected repos.
schedule: "0 18 * * 5"
autoApprove: read-only
catchUpOnStartup: false
maxIterations: 50
---

# Codebase Tech-Debt Radar

Walk the repos below, count debt markers, and write a trend report.

## Repos to scan

Edit these absolute paths to match your machine:

- `$HOME/code/jazz`
- `$HOME/code/<repo>`
- `$HOME/code/<repo>`

## Step 1 — Verify each repo exists

For each path:
- `ls <path>` to confirm.
- If missing, note it under `## Errors` in the final report and skip.

## Step 2 — Count markers

For each repo, run grep for all five markers, separately, scoped to source code only:

```bash
grep -rni --include='*.{ts,tsx,js,jsx,py,go,rs,java,kt,rb,php,c,cc,cpp,h,hpp,swift,scala}' \
  -E '\b(TODO|FIXME|HACK|XXX|DEPRECATED)\b' <repo>
```

Use the `grep` tool. Aggregate counts as:

| repo | TODO | FIXME | HACK | XXX | DEPRECATED | total |

## Step 3 — Categorize hotspots

For each repo, identify the top 5 files by total marker count (any kind). For each hotspot file, list:
- path (relative to repo root)
- count
- the 3 most recent markers in that file (line + the marker line text, truncated to 120 chars).

## Step 4 — Trend

For each repo, look up the count of markers as of the previous report (if one exists). The previous report path is `$HOME/.jazz/tech-debt-radar/<repo-basename>/<previous-friday-date>.md`. Parse the totals table out of the report's frontmatter (see Step 5 — frontmatter is the source of truth).

Compute the delta vs last week. Output `+N` or `-N` per repo per marker.

If no previous report exists, write `(first run)` for every delta.

## Step 5 — Write reports

Write one file per repo at `$HOME/.jazz/tech-debt-radar/<repo-basename>/<YYYY-MM-DD>.md`.

Use this layout, with the totals duplicated into YAML frontmatter so next week's run can parse them:

```markdown
---
generated: <ISO timestamp>
repo: <absolute repo path>
totals:
  TODO: <n>
  FIXME: <n>
  HACK: <n>
  XXX: <n>
  DEPRECATED: <n>
  total: <n>
---

# Tech Debt Radar — <repo-basename> — <YYYY-MM-DD>

## Totals
| Marker | Count | Δ vs last week |
| --- | --- | --- |
| TODO | <n> | <+/-N or (first run)> |
| ...

## Hotspots
1. **<path>** — <n> markers
   - L<line>: <text>
   - L<line>: <text>
   - L<line>: <text>
2. **<path>** — <n> markers
   - ...

## New this week
[List markers added in commits in the last 7 days. Use `git_log -p --since='7 days ago'` and grep additions for marker patterns. Show file:line + the line text. Cap at 20.]

## Resolved this week
[Same approach but for marker lines deleted in the last 7 days. Cap at 20.]
```

## Rules

- Read-only. Never edit any source file.
- Never run `git pull` or any network git op. The local working copy is the source of truth.
- Skip any path that isn't a git repo.
- Skip vendored / generated dirs: `node_modules`, `dist`, `build`, `target`, `vendor`, `.next`, `.turbo`. Use `--exclude-dir=...` on `grep`.
```

## How to install

```bash
mkdir -p ~/.jazz/workflows/codebase-tech-debt-radar
$EDITOR ~/.jazz/workflows/codebase-tech-debt-radar/WORKFLOW.md
# Edit the "Repos to scan" section to match your machine

# First run, foreground
jazz workflow run codebase-tech-debt-radar

# Schedule
jazz workflow schedule codebase-tech-debt-radar

# Look at the result
ls ~/.jazz/tech-debt-radar/*/
```

## How to customize

- **Different markers** — edit the `-E '\b(TODO|FIXME|...)\b'` regex. Add `WIP`, `OPTIMIZE`, etc.
- **Daily, not weekly** — set `schedule: "0 18 * * *"`. The trend computation still works since reports key on date.
- **Single repo** — keep one entry in "Repos to scan". The output dir layout still works.
- **Slack post** — pipe the latest report through your Slack webhook in a wrapper shell script, or add a final step that uses `http_request` to post.

## What you'll see

After two runs, each repo's folder under `~/.jazz/tech-debt-radar/<repo>/` contains weekly markdown snapshots with a trend column. After a quarter, you can `grep -h "^| total" ~/.jazz/tech-debt-radar/<repo>/*.md` to plot the line.

## Limits

- The "New this week" / "Resolved this week" sections rely on `git log -p --since='7 days ago'`. That misses force-pushed history rewrites — fine for most teams, false-zero for some.
- Only counts markers in source files matched by the `--include` glob. Markers in markdown, YAML, or shell scripts are skipped on purpose; widen the glob if you want them.
