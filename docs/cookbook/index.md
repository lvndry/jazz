# Jazz Workflow Cookbook

Forkable, production-ready workflow recipes you can drop into your machine or CI runner. Each recipe is a complete `WORKFLOW.md` file plus the install steps.

Workflows are what set Jazz apart from chat-only CLIs: they run on a cron schedule, headless, with a per-workflow auto-approve policy that controls how much autonomy the agent gets. Pick a recipe, copy it, customize the prompt, schedule it, and forget about it.

## Recipes

| Recipe | Schedule | Risk | What it does |
| --- | --- | --- | --- |
| [inbox-triage](./inbox-triage.md) | Weekday mornings | `low-risk` | Summarizes important email and archives the noise via Himalaya |
| [pr-watchdog](./pr-watchdog.md) | Daily | `read-only` | Scans open PRs, flags stale ones, posts a digest |
| [competitor-watch](./competitor-watch.md) | Weekly | `low-risk` | Scrapes competitor blogs/changelogs and writes a digest into Obsidian |
| [codebase-tech-debt-radar](./codebase-tech-debt-radar.md) | Weekly | `read-only` | Greps for FIXME / TODO / HACK and tracks the trend over time |
| [release-notes-draft](./release-notes-draft.md) | On `git tag` push (CI) | `high-risk` (auto) | Drafts release notes from commits and creates a GitHub release |
| [ci-pr-reviewer](./ci-pr-reviewer.md) | On every PR (CI) | `high-risk` (auto) | Reviews the diff and posts inline review comments |
| [research-digest](./research-digest.md) | Weekly | `read-only` | Web-research summary on a topic of your choice, saved to a file |

## How recipes are organized

Each recipe is one page with:

- The full `WORKFLOW.md` to copy
- Concrete shell commands to install and schedule it
- A short customization checklist
- An example of the output you should expect

## Where workflows live

Jazz looks for workflows in three places, in this order (later overrides earlier):

1. **Built-in** — shipped with the `jazz-ai` package
2. **Global** — `~/.jazz/workflows/<name>/WORKFLOW.md`
3. **Local** — `./workflows/<name>/WORKFLOW.md` (relative to cwd, scanned up to depth 4)

Most recipes here install to `~/.jazz/workflows/` so they work from any directory. The CI recipes live under `.github/jazz/workflows/` in your repo and are copied into a workspace at runtime.

## Auto-approve risk tiers

Set `autoApprove:` in frontmatter:

| Value | Auto-approves |
| --- | --- |
| `false` | Nothing — always asks (not useful for headless runs) |
| `read-only` | File reads, search, web requests, `git status`/`log`/`diff` |
| `low-risk` | + email archive, calendar create, file write to scratch dirs |
| `high-risk` | + edits to your repo, shell commands, git commits, git push |
| `true` | Same as `high-risk` |

Pick the lowest tier that lets the recipe finish.

## CLI cheat sheet

```bash
jazz workflow list                    # discover what's available
jazz workflow show <name>             # see the prompt + schedule
jazz workflow run <name>              # run once, foreground, with prompts
jazz workflow run <name> --auto-approve   # run unattended (uses the policy)
jazz workflow schedule <name>         # install into launchd / cron
jazz workflow unschedule <name>       # remove from launchd / cron
jazz workflow scheduled               # list what's scheduled
jazz workflow history <name>          # last runs for a workflow
jazz workflow catchup                 # run any that missed their slot
```

Logs land in `~/.jazz/logs/<workflow>.log` and `~/.jazz/logs/<workflow>.error.log` once scheduled.

See [`SUMMARY.md`](./SUMMARY.md) for notes on what was verified against the codebase and what is left to confirm.
