# inbox-triage

**What it does:** Each weekday morning, scans your inbox via the `email` skill (Himalaya CLI), surfaces the handful of messages that actually need a human, and archives the noise (newsletters, marketing, automated notifications).
**Schedule:** `0 8 * * 1-5` — 08:00 on weekdays.
**Risk:** `low-risk` — archiving and flagging are auto-approved; sending or deleting are not. The prompt explicitly forbids destructive actions.
**Tools used:** `email` skill (uses `shell_command`/`execute_command` under the hood to drive `himalaya`), `write_file` to a scratch summary file.

## Why this is useful

Most inbox-triage tools are either dumb filters (regex on subject) or full SaaS that read everything. This recipe runs locally against any IMAP account Himalaya supports (Gmail, Outlook, iCloud, Proton via Bridge, plain IMAP), uses an LLM to do the actual judgement, and is conservative by construction: when in doubt, the agent does nothing.

## The workflow file

```markdown
---
name: inbox-triage
description: Morning triage — summarize what matters, archive newsletters and noise.
schedule: "0 8 * * 1-5"
autoApprove: low-risk
catchUpOnStartup: true
maxCatchUpAge: 86400
maxIterations: 60
skills:
  - email
---

# Morning Inbox Triage

You are triaging my INBOX for the work day. The goal is a short, scannable summary plus a clean inbox.

## Step 1 — Inventory

1. Run `himalaya account list` and use the default account unless I have only one.
2. Pull the last 24 hours of mail from INBOX:
   ```bash
   himalaya envelope list --folder INBOX --output json --page-size 100 "after $(date -u -v-1d +%Y-%m-%d 2>/dev/null || date -u -d '1 day ago' +%Y-%m-%d)"
   ```
3. Parse JSON. For each envelope keep `id`, `subject`, `from`, `date`, `flags`.

## Step 2 — Classify

Tag each message with exactly one bucket:

- `important` — a real person writing me directly, an action item, a reply I owe, a bill, a security alert, anything from a known coworker / family member.
- `fyi` — a real human update I should read but does not need a reply (release notes from a small team, a friend sharing a link).
- `newsletter` — anything that smells like a periodic publication (Substack, marketing, product updates, conference roundups).
- `automated` — CI failures, GitHub notifications, calendar invites, monitoring alerts, anything from `noreply@` / `no-reply@`.
- `unknown` — you genuinely cannot tell.

## Step 3 — Act

- **Archive** all `newsletter` and `automated` messages older than 24h:
  ```bash
  himalaya message move <id> --folder Archive
  ```
  Batch IDs when possible. The `Archive` folder name varies by provider — check `himalaya folder list` first and use whatever maps to "All Mail" / "Archive".
- **Do nothing** with `important`, `fyi`, or `unknown`. Never delete. Never mark seen. Never reply.

## Step 4 — Summary

Write a markdown summary to `$HOME/.jazz/inbox-triage/$(date +%Y-%m-%d).md` with this shape:

```markdown
# Inbox Triage — <date>

## Needs your attention (<N>)
- **<from>** — <subject>
  Why: <one-line reason>

## FYI (<N>)
- **<from>** — <subject>

## Archived (<N>)
- <count> newsletters
- <count> automated notifications

## Skipped (unknown) (<N>)
- **<from>** — <subject>
```

## Safety rules — read every run

- When in doubt, **leave the message alone**.
- Never delete. Never empty trash.
- Never reply, never forward, never send.
- Never touch flags besides what you need to read the message.
- If `himalaya account list` returns nothing or errors, write a one-line failure note to the summary file and stop.
```

## How to install

```bash
# 1. Install Himalaya if you don't have it
brew install himalaya            # macOS
# or: cargo install himalaya --locked

# 2. Configure at least one account (interactive wizard)
himalaya account configure default

# 3. Drop the workflow into your global Jazz workflows dir
mkdir -p ~/.jazz/workflows/inbox-triage
$EDITOR ~/.jazz/workflows/inbox-triage/WORKFLOW.md   # paste the file above

# 4. Verify Jazz sees it
jazz workflow list | grep inbox-triage

# 5. Run it once foreground, watch what it does
jazz workflow run inbox-triage

# 6. Once you trust it, schedule it
jazz workflow schedule inbox-triage

# Tail the log on the next run
tail -f ~/.jazz/logs/inbox-triage.log
```

## How to customize

- **Multiple accounts** — change Step 1 to loop `himalaya account list --output json | jq -r '.[].name'` and triage each.
- **Different threshold** — edit the `after $(date ...)` window in Step 1 (e.g. `-3d` over a weekend).
- **Different rules** — add categories (e.g. `receipt` → move to `Receipts/<year>`). Keep the "when in doubt, do nothing" rule.
- **Trusted senders** — paste a list of allow-listed addresses in the prompt; ask the agent to never archive anything from them.

## What you'll see

- A daily file at `~/.jazz/inbox-triage/YYYY-MM-DD.md` with three or four short sections.
- A measurably smaller inbox (newsletters and automated notifications gone).
- Zero deleted mail, zero sent mail, zero replies — by design.

## Limits

- Requires the `email` skill and a working `himalaya` install. The skill ships with Jazz; Himalaya is a third-party CLI you install yourself.
- `low-risk` policy auto-approves the `move` command. If you'd rather hand-approve, drop to `read-only` and run interactively.
