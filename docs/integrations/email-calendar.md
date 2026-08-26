---
description: "Give a Jazz agent email and calendar access through the Himalaya-backed email skill and calendar skill — scoped credentials, explicit approval for sends."
---

# Email & Calendar

How to let an agent read your mail or your calendar.

Email and calendar are **skills**, not built-in tools. They drive CLI programs
([Himalaya](https://github.com/pimalaya/himalaya), [khal](https://github.com/pimutils/khal))
through `execute_command`.

> ⚠️ **This has an approval consequence.** Because these skills shell out,
> every action they take is gated at `high-risk` — a `low-risk` unattended run **cannot
> archive an email**. Keep the tier low and allowlist the binary instead:
> `{"autoApprovedCommands": ["himalaya", "khal", "gcalcli"]}` in `~/.jazz/config.json`. See
> [Tools reference](../reference/tools.md#what-is-not-a-built-in-tool).

---

Jazz uses **skills** for email and calendar—agents run Himalaya and khal via `execute_command`. This is provider-agnostic and works with Gmail, Outlook, iCloud, Fastmail, and more.

## Email (Himalaya Skill)

Use the **email** skill with [Himalaya CLI](https://github.com/pimalaya/himalaya) for inbox management. Himalaya works with Gmail, Outlook, iCloud, Proton Mail, and more via IMAP/SMTP.

- **Setup**: Load the `email` skill — it installs Himalaya if missing (from the live README) and walks you through account setup, then you can check mail
- **Agents**: Load the `email` skill—it teaches agents to use Himalaya for list, read, send, reply, search, and organize
- **Provider-agnostic**: One setup works across Gmail, Outlook, iCloud, Fastmail, etc.

## Calendar (khal Skill)

Use the **calendar** skill with [khal](https://github.com/pimutils/khal) and [vdirsyncer](https://github.com/pimutils/vdirsyncer) for event management. Works with iCloud, Nextcloud, Fastmail, and any standards-compliant CalDAV server.

- **Setup**: Install khal and vdirsyncer, configure CalDAV in vdirsyncer, point khal at the synced calendars
- **Agents**: Load the `calendar` skill—it teaches agents to use khal for listing, creating, editing, and searching events
- **Sync**: Run `vdirsyncer sync` before reads to ensure up-to-date data

**Google Calendar is the exception** — its CalDAV endpoint rejects the discovery handshake khal/vdirsyncer need to auto-configure, and no longer accepts app-password auth either. The `calendar` skill uses [gcalcli](https://github.com/insanum/gcalcli) for Google accounts instead, which talks to the Calendar REST API directly. See the skill's [Google Calendar (gcalcli)](../../skills/calendar/SKILL.md#google-calendar-gcalcli) section for the OAuth setup.

---

---

## Related

- [Integrations index](./index.md)
- [Configuration](../reference/configuration.md) — the full config file reference
- [MCP Servers](./mcp.md)
