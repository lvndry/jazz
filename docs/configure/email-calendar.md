---
description: "Connect Jazz agents to email and calendars through maintained CLI skills, with explicit account setup and approval boundaries for mailbox changes and events."
---

# Connect email and calendars

Jazz integrates email and calendars through skills that teach the agent to operate established local programs. They are not built-in Jazz tools and they do not bypass the approval policy.

- The `email` skill uses [Himalaya](https://github.com/pimalaya/himalaya) for IMAP and SMTP accounts.
- The `calendar` skill uses [khal](https://github.com/pimutils/khal) with vdirsyncer for CalDAV, or [gcalcli](https://github.com/insanum/gcalcli) for Google Calendar.

The same setup can be reused by agents backed by different models because account access belongs to the host integration, not the model provider.

## Email

Install Himalaya and configure the account outside an unattended run:

```bash
brew install himalaya
himalaya account configure default
himalaya envelope list --folder INBOX --page-size 5
```

Then include the `email` skill in the agent or workflow. The skill covers listing, reading, searching, organizing, replying, and sending, subject to the installed Himalaya version and account permissions.

Himalaya commands execute through `execute_command`. Jazz classifies the actual command before applying approval policy. A read-only run may list or read mail when the classifier can establish that the command is inspect-only; archive, move, reply, send, and delete operations should be treated as mutations.

Do not broadly add `himalaya` to `autoApprovedCommands` for an unattended agent. The allowlist key includes the binary and first subcommand, which may not distinguish a safe mailbox operation from a more consequential operation sharing that subcommand.

The [read-only inbox briefing](../guides/inbox-triage.md) demonstrates a schedule that never changes mailbox state.

## CalDAV calendars

Install khal and vdirsyncer, configure the CalDAV account, synchronize it, and verify a local read before involving Jazz:

```bash
vdirsyncer sync
khal list now 7d
```

Use the `calendar` skill after the host commands work. The skill can inspect events and, when approved, create or edit them.

Calendar data is usually cached locally by vdirsyncer. Decide whether synchronization happens before every Jazz run, on its own schedule, or through an explicit operator command. A stale local cache is a data-quality failure, not an agent reasoning failure.

## Google Calendar

The calendar skill uses gcalcli for Google accounts because Google's current authentication and discovery path does not fit the khal/vdirsyncer setup used for ordinary CalDAV servers. Complete gcalcli's OAuth setup interactively, then verify `gcalcli agenda` before scheduling an agent.

## Security boundary

- Use a dedicated or narrowly scoped account when the agent does not need your full mailbox or calendar.
- Keep account credentials in each integration's credential store, not in prompts or workflow Markdown.
- Separate briefing workflows from mutation workflows so reading mail does not imply permission to send it.
- Treat message bodies, invitations, and event descriptions as untrusted input capable of containing prompt injection.
- Require human approval for outbound mail and consequential calendar changes unless a narrowly defined automation has been reviewed end to end.
- Test scheduled work with the same unattended approval policy before installing it.

Read the source skills at [`skills/email/SKILL.md`](../../skills/email/SKILL.md) and [`skills/calendar/SKILL.md`](../../skills/calendar/SKILL.md) for current command usage. See [Tools and approvals](../security/approvals.md) for gating and [Scheduled runs](../surfaces/scheduled.md) for unattended behavior.
