# pr-watchdog

**What it does:** Once a day, scans the open pull requests on your repo(s) using the GitHub CLI, flags PRs that are stale or blocked, and writes a short digest you can paste into Slack.
**Schedule:** `0 9 * * 1-5` — 09:00 weekdays.
**Risk:** `read-only` — only reads from the GitHub API, writes a single markdown file.
**Tools used:** `shell_command` (to run `gh`), `write_file`, `web_search` is *not* needed.

## Why this is useful

PRs rot. A 14-day-old PR is usually a 14-day-old conflict + 14-day-old context. A daily nudge surfaces them before they become impossible to merge. This recipe is intentionally CLI-only — no GitHub Actions, no webhooks — so it works on private mirrors and self-hosted setups too, as long as `gh` is logged in.

## The workflow file

```markdown
---
name: pr-watchdog
description: Daily scan of open PRs — flag stale ones, draft a digest.
schedule: "0 9 * * 1-5"
autoApprove: read-only
catchUpOnStartup: true
maxCatchUpAge: 86400
maxIterations: 40
---

# Pull Request Watchdog

Build a digest of open pull requests across the repos I care about. Output is a markdown file I can copy-paste into Slack.

## Repos to scan

Edit this list directly in the WORKFLOW.md:

- `lvndry/jazz`
- `<owner>/<repo>`
- `<owner>/<repo>`

## Step 1 — Verify `gh` is authenticated

```bash
gh auth status
```

If this fails, write a single-line failure note to the output file (see Step 4) explaining `gh auth login` is required, and stop.

## Step 2 — Pull open PRs per repo

For each repo, run:

```bash
gh pr list \
  --repo <owner>/<repo> \
  --state open \
  --json number,title,author,createdAt,updatedAt,isDraft,labels,reviewDecision,mergeable,additions,deletions,url \
  --limit 100
```

## Step 3 — Classify

Bucket each PR using these rules. Stop at the first match.

- **Blocked** — `mergeable == "CONFLICTING"` or `reviewDecision == "CHANGES_REQUESTED"`.
- **Stale** — `updatedAt` is more than 7 days ago and not draft.
- **Awaiting review** — open ≥ 24h, no `reviewDecision`, not draft.
- **Big** — `additions + deletions > 800`.
- **Draft** — `isDraft == true` (separate section, not flagged).
- **Healthy** — everything else (don't include in the digest).

A PR can land in only one bucket. Order matters: blocked > stale > awaiting review > big > draft.

## Step 4 — Write the digest

Save to `$HOME/.jazz/pr-watchdog/$(date +%Y-%m-%d).md`. Use this layout:

```markdown
# PR Watchdog — <date>

## Blocked (<N>)
- **<repo>#<num>** <title> — by @<author> · <age>
  Why: <conflict | changes requested>
  <url>

## Stale (<N>)
- **<repo>#<num>** <title> — by @<author> · last updated <age>
  <url>

## Awaiting review (<N>)
- **<repo>#<num>** <title> — by @<author> · open <age>
  <url>

## Large PRs (<N>)
- **<repo>#<num>** <title> — +<add>/-<del>
  <url>

## Drafts (<N>)
- <repo>#<num> <title> — by @<author>
```

Show counts of zero as `(0)` and skip the section body. If every section is empty, write:

> All clear. No PRs needed attention on <date>.

## Rules

- Read-only. Never comment, label, merge, close, or approve.
- If a repo errors (404, rate limit), note it under the digest in a `## Errors` section and continue with the rest.
- Do not invent PRs that aren't in the `gh pr list` output.
```

## How to install

```bash
# 1. Install and log in to gh
brew install gh                  # or your platform's package manager
gh auth login

# 2. Drop in the workflow
mkdir -p ~/.jazz/workflows/pr-watchdog
$EDITOR ~/.jazz/workflows/pr-watchdog/WORKFLOW.md  # paste the file above
# Edit the "Repos to scan" list

# 3. Dry run
jazz workflow run pr-watchdog

# 4. Schedule
jazz workflow schedule pr-watchdog
```

The output file lands at `~/.jazz/pr-watchdog/YYYY-MM-DD.md`. Pipe it into Slack with anything that reads stdin:

```bash
# example: post to a webhook
curl -X POST -H 'Content-Type: application/json' \
  --data "$(jq -Rs '{text: .}' < ~/.jazz/pr-watchdog/$(date +%Y-%m-%d).md)" \
  $SLACK_WEBHOOK_URL
```

## How to customize

- **Filter by author** — add `--author "@me"` to the `gh pr list` command if you only care about your own PRs.
- **Different staleness threshold** — change "more than 7 days" in Step 3 to whatever makes sense for your team.
- **Slack-native output** — replace the markdown template with Slack `mrkdwn` (no `#` headings; bullets work fine).
- **GitHub Enterprise** — `gh auth login --hostname github.example.com` once; the workflow does not change.

## What you'll see

A short, scannable file every weekday at 09:00, with at most ~25 PRs. The blocked/stale/awaiting-review buckets give you a one-glance triage list. After a week of running it, "Stale (0)" becomes the new normal.

## Limits

- Needs `gh` installed and authenticated on the machine where the workflow runs.
- The agent is read-only against the GitHub API by design — it never auto-pings reviewers or auto-merges. Wire that in yourself if you want it.
