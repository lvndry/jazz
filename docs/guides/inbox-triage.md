---
description: "Build a read-only Jazz morning inbox briefing that finds messages needing attention without sending, deleting, archiving, or changing email state."
---

# Start each workday with a read-only inbox briefing

Use this workflow when you want an agent to reduce a busy inbox to a short action list, but you do not want unattended automation changing or sending mail.

Jazz reads recent messages through the `email` skill, distinguishes obligations from noise, and writes the briefing to the workflow's normal output and history. It never replies, deletes, archives, marks messages read, or changes flags.

## 1. Connect the mailbox

Jazz's email skill uses [Himalaya](https://github.com/pimalaya/himalaya), a local CLI for IMAP and SMTP accounts. Configure it interactively before scheduling anything:

```bash
brew install himalaya
himalaya account configure default
himalaya envelope list --folder INBOX --page-size 5
```

Linux users can install Himalaya with their package manager or its documented Cargo installation. Use an account credential limited to the mailbox this agent needs.

## 2. Create the workflow

Create `~/.jazz/workflows/morning-inbox/WORKFLOW.md`:

```markdown
---
name: morning-inbox
description: "Summarize recent mail that needs my attention"
schedule: "0 8 * * 1-5"
agent: inbox-assistant
autoApprove: read-only
maxIterations: 40
maxDurationMs: 300000
skills:
  - email
---

# Morning inbox briefing

Use the email skill to inspect messages received in the last 24 hours.

Return a concise briefing with these sections:

1. **Reply today** — direct questions, commitments, approvals, and time-sensitive requests.
2. **Action without reply** — bills, security alerts, forms, or tasks with a deadline.
3. **Read when possible** — relevant human updates that require no action.
4. **Noise count** — counts only for newsletters, automated notifications, and marketing.

For every item in the first two sections, include sender, subject, requested action, and any explicit deadline. Quote no more message content than needed to justify the classification.

When uncertain, keep the message visible and label the uncertainty. Never send, reply, forward, delete, archive, move, mark read, or change flags. Do not write a separate summary file; return the briefing as the workflow result.
```

This deliberately produces no mailbox mutation. `execute_command` still mediates Himalaya, and Jazz classifies each proposed command before applying the workflow's read-only policy. Any ambiguous or mutating command fails closed.

## 3. Test with the unattended policy

Run the same policy the scheduler will use:

```bash
jazz workflow run morning-inbox --auto-approve
```

Check that the result identifies real obligations and that `jazz workflow history morning-inbox` records it. If a read command is declined, inspect the proposed command rather than raising the entire policy.

Do not add `himalaya` broadly to `autoApprovedCommands`: Jazz keys that allowlist by binary and first subcommand, and a broad entry can authorize more mailbox actions than this briefing needs.

## 4. Schedule it

```bash
jazz workflow schedule morning-inbox
jazz workflow scheduled
```

Jazz installs the workflow through launchd on macOS or cron on Linux. The machine must be awake at the scheduled time; [scheduled runs](../surfaces/scheduled.md) explains catch-up behavior and always-on hosts.

## What this unlocks

- The mailbox stays under human control while the model performs prioritization.
- The output is useful to a person but also parseable by another surface or notification adapter.
- Provider and model choice remain independent of the email integration and schedule.
- The same agent can later be reached interactively to inspect one item in context.

If you want automatic archiving or sending, treat that as a separate workflow with a narrower integration and an explicit approval design. Do not quietly widen this briefing's permissions.

Read [Email and calendar](../configure/email-calendar.md), [Scheduled runs](../surfaces/scheduled.md), and [Tools and approvals](../security/approvals.md) for the underlying contracts.
