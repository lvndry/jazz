---
name: calendar
description: Manage calendars using khal CLI and vdirsyncer for CalDAV providers, or gcalcli for Google Calendar. Use when the user wants to view, create, edit, or delete calendar events, sync calendars, manage multiple calendars, or mentions "calendar", "event", "appointment", "meeting", "schedule", "CalDAV", "khal", "vdirsyncer", "gcalcli", "Google Calendar".
---

# Calendar Management

Manage calendars using [khal](https://github.com/pimutils/khal) - a standards-based CLI calendar application, and [vdirsyncer](https://github.com/pimutils/vdirsyncer) - a tool for synchronizing calendars with CalDAV servers.

**Google Calendar is the one exception: use [gcalcli](https://github.com/insanum/gcalcli) instead, not khal/vdirsyncer.** Google's CalDAV endpoint rejects the RFC 6764 principal-discovery handshake every generic CalDAV client (including vdirsyncer's own `google_calendar` OAuth backend) needs to auto-configure — confirmed via a `403 Given URL is not a homeset URL` even with a valid OAuth token, on top of app-password Basic Auth being rejected outright. gcalcli talks to the real Calendar REST API v3, not CalDAV, so it's unaffected. See [Google Calendar (gcalcli)](#google-calendar-gcalcli) below. Every other provider in the table below (iCloud, Nextcloud, Fastmail, Radicale) works fine with khal/vdirsyncer.

## Agent Usage (Power User Patterns)

**When using this skill as an agent**, run commands via `execute_command`. Prefer these patterns:

1. **Sync before read**: Run `vdirsyncer sync` first to ensure local data is up to date, especially for remote calendars. **Skip this entirely for Google accounts** — gcalcli reads the live API, and a Google-only deployment has no working vdirsyncer pair to sync. If `khal printcalendars` errors or lists nothing, khal is not the path on this machine: check for gcalcli accounts (see [Google Calendar (gcalcli)](#google-calendar-gcalcli)) before reporting the calendar as unreachable.

2. **Use `khal list`** for human-readable output, or `khal list --format "{start} {end} {title}" <date range>` for parsing. For machine parsing, `khal printcalendars -p` exports ICS.

3. **Natural language quick add** works well: `khal new "Team meeting tomorrow 3pm-4pm"` or `khal new "Lunch with John next Tuesday at noon"`

4. **Structured create** when you have exact details:
   ```bash
   khal new -a work 2026-02-15 14:00 1h "Sprint Planning" --location "Room A"
   ```

5. **Find UID before edit/delete**: `khal search "meeting"` or `khal search --days 7 "project"` returns UIDs. Use the UID with `khal edit <uid>` or `khal delete <uid>`.

6. **List calendars** first: `khal printcalendars` shows available calendars. Use `-a <calendar>` to target a specific one.

7. **Date ranges**: `khal list today`, `khal list week`, `khal list 2026-02-01 2026-02-28`, or `khal list tomorrow`

## Prerequisites Check

Before any calendar operation, verify tools are installed and configured:

```bash
# Check if khal is installed
which khal

# Check if vdirsyncer is installed
which vdirsyncer

# Check khal configuration
khal printcalendars

# Check vdirsyncer configuration
vdirsyncer discover
```

If not installed → Guide through [Installation](#installation)
If no calendars → Guide through [Calendar Setup](#calendar-setup)

---

## Installation

### macOS (Homebrew)

```bash
brew install khal
brew install vdirsyncer
```

### Arch Linux

```bash
pacman -S khal
pacman -S vdirsyncer
```

### Debian/Ubuntu

```bash
apt install khal
apt install vdirsyncer
```

### Nix

```bash
nix-env -i khal
nix-env -i vdirsyncer
```

### FreeBSD

```bash
pkg install py-khal
pkg install py-vdirsyncer
```

### pip (Any OS)

```bash
pip install khal
pip install vdirsyncer
```

### Install Latest Version

```bash
pip install git+https://github.com/pimutils/khal
pip install git+https://github.com/pimutils/vdirsyncer
```

---

## Calendar Setup

### Quick Start: Local Calendar Only

Create a basic local calendar configuration:

```bash
# Create config directory
mkdir -p ~/.config/khal

# Create basic config
cat > ~/.config/khal/config << 'EOF'
[calendars]

[[personal]]
path = ~/.local/share/khal/calendars/personal
color = dark blue

[locale]
timeformat = %H:%M
dateformat = %Y-%m-%d
longdateformat = %Y-%m-%d
datetimeformat = %Y-%m-%d %H:%M
longdatetimeformat = %Y-%m-%d %H:%M
EOF

# Create calendar directory
mkdir -p ~/.local/share/khal/calendars/personal
```

### Advanced: Sync with CalDAV Server

**Step 1: Configure vdirsyncer**

```bash
# Create vdirsyncer config directory
mkdir -p ~/.config/vdirsyncer

# Create configuration (example for generic CalDAV)
cat > ~/.config/vdirsyncer/config << 'EOF'
[general]
status_path = "~/.local/share/vdirsyncer/status/"

# Personal calendar pair
[pair personal_calendar]
a = "personal_local"
b = "personal_remote"
collections = ["from a", "from b"]

# Local storage
[storage personal_local]
type = "filesystem"
path = "~/.local/share/khal/calendars/"
fileext = ".ics"

# Remote CalDAV storage
[storage personal_remote]
type = "caldav"
url = "https://caldav.example.com/"
username = "your_username"
password.fetch = ["command", "pass", "caldav/password"]
EOF
```

**Step 2: Discover calendars**

```bash
# Discover available calendars on the server
vdirsyncer discover

# First sync
vdirsyncer sync
```

**Step 3: Configure khal to use synced calendars**

```bash
cat > ~/.config/khal/config << 'EOF'
[calendars]

[[personal]]
path = ~/.local/share/khal/calendars/personal
color = dark blue
priority = 20

[[work]]
path = ~/.local/share/khal/calendars/work
color = dark red
priority = 10

[locale]
timeformat = %H:%M
dateformat = %Y-%m-%d
longdateformat = %Y-%m-%d
datetimeformat = %Y-%m-%d %H:%M
longdatetimeformat = %Y-%m-%d %H:%M

firstweekday = 0  # Monday
weeknumbers = right

[default]
default_calendar = personal
EOF
```

### Provider-Specific Setup

| Provider            | CalDAV URL                                        | Notes                                            |
| ------------------- | -------------------------------------------------- | ----------------------------------------------- |
| **Google Calendar** | not supported via CalDAV                           | Use [gcalcli](#google-calendar-gcalcli) instead |
| **Nextcloud**       | `https://nextcloud.example.com/remote.php/dav/`    | Standard username/password         |
| **iCloud**          | `https://caldav.icloud.com/`                       | Requires app-specific password     |
| **Fastmail**        | `https://caldav.fastmail.com/dav/calendars/user/`  | Standard username/password         |
| **Radicale**        | `http://localhost:5232/`                           | Self-hosted, standard auth         |

**💡 Tip**: Most non-Google providers use the same app-specific password for both email and calendar. Store credentials in `pass` with consistent naming (e.g., `icloud/app-password`) to reuse them across both email and calendar skills. For multiple accounts, use a hierarchical structure (e.g., `icloud/personal/app-password`, `icloud/work/app-password`)—the `/` creates folders to keep things organized.

For detailed provider configurations, see [references/providers.md](references/providers.md)

---

## Google Calendar (gcalcli)

Google's CalDAV endpoint doesn't support the discovery handshake generic CalDAV clients rely on, and no longer accepts app-password Basic Auth either — so this is the one provider that needs a completely different tool and setup path.

### Prerequisites Check

```bash
command -v gcalcli
```

If missing, install it (`pip install --break-system-packages gcalcli` on Debian-family systems where apt owns the Python environment, plain `pip install gcalcli`/`pipx install gcalcli` elsewhere).

### Check for already-configured accounts before assuming there are none

gcalcli's cache lives at `$XDG_DATA_HOME/gcalcli/oauth`, and **many deployments (e.g. Docker containers) set `$XDG_DATA_HOME` to something other than the Unix default `~/.local/share`.** Checking `~/.local/share/gcalcli-*` and finding nothing does not mean no account is set up — it may just mean you checked the wrong base directory. Before concluding "gcalcli isn't authenticated" or starting a new OAuth setup:

```bash
echo "$XDG_DATA_HOME"                                  # the actual base dir this deployment uses, if set
find "${XDG_DATA_HOME:-$HOME/.local/share}"/.. -maxdepth 2 -iname "gcalcli*" 2>/dev/null
find / -maxdepth 4 -iname "gcalcli-*" -type d 2>/dev/null   # last resort if the above finds nothing
```

Each match is one already-authorized account (directory name is usually the account's own name); use it directly with the `XDG_DATA_HOME=<that directory> gcalcli ...` pattern below rather than re-running OAuth setup.

### One-time OAuth client (per deployment, not per account)

1. In [Google Cloud Console](https://console.cloud.google.com): create/reuse a project, enable the **Google Calendar API**.
2. **OAuth consent screen**: User type External, add every Google account that will use this as a **test user** (keeps the app in Testing mode — no Google verification review needed).
3. **Credentials → Create Credentials → OAuth client ID**, application type **Desktop app**. This gives a `client_id` and `client_secret` shared across every account below.

### Per-account authorization

**Everything in this section is per Google account — run the whole procedure once for each one.** There's no single "add another account" shortcut; each account gets its own data directory and goes through its own consent. The examples below authorize two accounts, `account-a` and `account-b`, side by side specifically so the pattern is obvious to repeat for a third, fourth, etc. — just pick a new `$ACCOUNT_NAME` and a new `$ACCOUNT_EMAIL` each time and redo every step.

gcalcli's credential cache path is keyed off `$XDG_DATA_HOME` (specifically `$XDG_DATA_HOME/gcalcli/oauth`), **not** `--config-folder` — running it for a second account without isolating that path overwrites the first account's cache. Give each account its own data directory, named after the account itself:

```bash
XDG_DATA_HOME=~/.local/share/gcalcli-account-a gcalcli --client-id "$CLIENT_ID" --client-secret "$CLIENT_SECRET" init
XDG_DATA_HOME=~/.local/share/gcalcli-account-b gcalcli --client-id "$CLIENT_ID" --client-secret "$CLIENT_SECRET" init
```

`$CLIENT_ID`/`$CLIENT_SECRET` are the same values for every account (one shared OAuth client from the previous step) — only the data directory and, during consent, which Google account you log in as change per account.

`init` opens a browser consent flow. If it hangs after clicking Allow (a known issue: the local callback server can grab the wrong one of two connections a browser opens and block forever waiting for data that never arrives on it), don't keep retrying it — Google still put the authorization `code` in the browser's address bar even though the page failed to load. Recover manually — **again, do this once per account**, substituting that account's `$ACCOUNT_NAME`/`$ACCOUNT_EMAIL`/`$XDG_DATA_HOME` each time:

1. Build the URL yourself instead of using gcalcli's printed one — no PKCE, no port-forwarding needed, since the redirect target never has to actually respond:
   ```
   https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=CLIENT_ID&redirect_uri=http://localhost:8080&scope=https://www.googleapis.com/auth/calendar&access_type=offline&prompt=select_account%20consent&login_hint=ACCOUNT_EMAIL
   ```
   Set `ACCOUNT_EMAIL` to the specific account you're authorizing right now (`account-a`'s address the first time through, `account-b`'s the second). `prompt=select_account consent` is **required** whenever more than one Google account will ever be authorized against this same client — omit it and Google silently reuses whichever account is already logged into the browser instead of prompting, so `account-b`'s token ends up authenticating as `account-a` (this is not hypothetical — it's exactly what happened the first time this was set up, and the fix was re-running the flow with this parameter and clearing the wrongly-written cache first).
2. After clicking Allow, copy the failed `http://localhost:8080/?...&code=...` URL from the address bar and extract `code`.
3. Exchange it directly:
   ```bash
   curl -s -X POST https://oauth2.googleapis.com/token \
     -d "code=$CODE" -d "client_id=$CLIENT_ID" -d "client_secret=$CLIENT_SECRET" \
     -d "redirect_uri=http://localhost:8080" -d "grant_type=authorization_code"
   ```
4. Write the response into **that account's** `$XDG_DATA_HOME/gcalcli/oauth` (e.g. `~/.local/share/gcalcli-account-a/gcalcli/oauth` for `account-a`, `~/.local/share/gcalcli-account-b/gcalcli/oauth` for `account-b`) as JSON with keys `access_token`, `client_id`, `client_secret`, `refresh_token`, `token_uri` (`https://oauth2.googleapis.com/token`), `scopes` (a list) — gcalcli's legacy-JSON loader accepts this shape and converts it to its normal pickle cache on next use.
5. Verify **before moving to the next account**: `XDG_DATA_HOME=~/.local/share/gcalcli-account-a gcalcli list` should show `account-a`'s calendars, not any other account's. If two accounts ever show the same calendars, step 1's `login_hint`/`prompt` was skipped or the wrong `$XDG_DATA_HOME` was used — redo that account.

### Usage

Always set `XDG_DATA_HOME` to the right account's directory before invoking `gcalcli` — there's no `--account` flag, isolation is entirely by data directory. The same command works for any account; only the directory changes:

```bash
XDG_DATA_HOME=~/.local/share/gcalcli-account-a gcalcli agenda
XDG_DATA_HOME=~/.local/share/gcalcli-account-b gcalcli agenda

XDG_DATA_HOME=~/.local/share/gcalcli-account-a gcalcli quick "Lunch with John tomorrow at noon"
XDG_DATA_HOME=~/.local/share/gcalcli-account-b gcalcli add --title "Sprint Planning" --where "Room A" --when "2026-02-15 14:00" --duration 1h
```

#### Date ranges: a bare number is a *date*, never a count of days

`agenda` and `search` take `[start] [end]` as **dates**, not a window size. `gcalcli agenda 30`
does not mean "the next 30 days" — dateutil parses `30` as *the 30th of the current month*, so
the window starts there and silently hides everything before it. `agenda 120` is not a valid
date at all and returns a bare `No Events Found...` rather than an error, which reads exactly
like an empty calendar. Always give a real range:

```bash
XDG_DATA_HOME=~/.local/share/gcalcli-account-a gcalcli agenda today "120 days"
XDG_DATA_HOME=~/.local/share/gcalcli-account-a gcalcli agenda 2026-08-25 2026-12-25
```

#### Search matches whole words, not substrings

`search` forwards the query to Google's Calendar API, which tokenises event text and matches
whole words — it is not `grep`. Searching a truncated stem finds nothing even when the event is
right there: `gcalcli search podo` returns `No Events Found...` for an event titled
`Rendez vous podologue`, while `gcalcli search podologue` finds it. Search the full word the
event would actually contain, and if a search comes back empty, confirm against a date-ranged
`agenda` before concluding the calendar is empty or unreachable.

#### Run one plain command per account, not a shell loop

Wrapping calls in `for account in a b; do … gcalcli …; done` defeats the `autoApprovedCommands`
allowlist: approval keys off the *first* binary in the command, so the key becomes `for account`
and never matches an allowlisted `gcalcli`, forcing a manual approval prompt on every turn. A
leading `XDG_DATA_HOME=…` assignment is fine — env-var prefixes are skipped when the key is
extracted. Issue one command per account instead.

---

## Common Operations

### View Calendar

```bash
# View calendar in interactive mode (ikhal)
ikhal

# View today's events
khal list today

# View this week
khal list week

# View specific date
khal list 2026-02-15

# View date range
khal list 2026-02-01 2026-02-28

# Calendar overview for the month
khal calendar
```

### Create Events

```bash
# Quick add event (natural language)
khal new "Team meeting tomorrow 3pm-4pm"

# Structured add with details
khal new -a work \
  --location "Conference Room A" \
  --categories "meeting,important" \
  2026-02-15 14:00 1h "Sprint Planning"

# All-day event
khal new 2026-02-20 "Birthday Party" -a personal

# Recurring event (every Monday at 9am)
khal new --repeat weekly --until 2026-12-31 \
  "2026-02-03 09:00" 1h "Weekly Standup"

# Event with description
khal new "2026-02-15 14:00" 2h "Project Review" \
  --description "Discuss Q1 deliverables and roadmap"
```

### Edit Events

```bash
# Interactive edit (opens in ikhal)
ikhal

# Search for event
khal search "meeting"

# Edit event by UID (use search to find UID first)
khal edit <event-uid>
```

### Delete Events

```bash
# Delete event by UID
khal delete <event-uid>

# Interactive delete (in ikhal)
ikhal
# Navigate to event, press 'd' to delete
```

### Search Events

```bash
# Search by keyword
khal search "meeting"

# Search in specific calendar
khal search -a work "review"

# Search in date range
khal search --days 30 "birthday"
```

### Synchronization

```bash
# Sync all calendars with remote servers
vdirsyncer sync

# Sync specific calendar pair
vdirsyncer sync personal_calendar

# Force full sync
vdirsyncer sync --force-delete

# Automated sync (add to crontab)
# Sync every 15 minutes
*/15 * * * * vdirsyncer sync >/dev/null 2>&1
```

---

## Interactive Calendar (ikhal)

`ikhal` is the interactive TUI for browsing and editing calendars.

### Launch

```bash
ikhal
```

### Keyboard Shortcuts

| Key     | Action                |
| ------- | --------------------- |
| `n`     | Create new event      |
| `e`     | Edit selected event   |
| `d`     | Delete selected event |
| `t`     | Jump to today         |
| `/`     | Search events         |
| `↑↓←→`  | Navigate calendar     |
| `Enter` | View event details    |
| `Tab`   | Switch between panes  |
| `q`     | Quit                  |

---

## Advanced Workflows

### Import ICS Files

```bash
# Import external .ics file
khal import event.ics -a personal

# Import from URL
curl -L https://example.com/calendar.ics | khal import -a personal -
```

### Export Calendar

```bash
# Export all events to ICS
khal printcalendars -p > my_calendars.ics

# Export specific date range
khal list --format "{start-date} {title}" 2026-01-01 2026-12-31 > events.txt
```

### Multiple Calendars

```bash
# List all configured calendars
khal printcalendars

# Add event to specific calendar
khal new -a work "Meeting" 2026-02-15 14:00 1h

# View events from specific calendar only
khal list -a personal today
```

### Event Reminders

Configure desktop notifications by adding to khal config:

```ini
[default]
default_event_duration = 1h
default_dayevent_duration = 1d

[view]
event_view_always_visible = True

# Notification (requires system notification daemon)
[notifications]
notify = 15  # Notify 15 minutes before event
```

---

## Configuration Tips

### Time Zones

Handle multiple time zones in `~/.config/khal/config`:

```ini
[locale]
local_timezone = America/New_York
default_timezone = America/New_York
```

### Calendar Colors

Customize calendar colors for better visibility:

```ini
[calendars]

[[work]]
path = ~/.local/share/khal/calendars/work
color = dark red
priority = 10

[[personal]]
path = ~/.local/share/khal/calendars/personal
color = dark blue
priority = 20

[[birthdays]]
path = ~/.local/share/khal/calendars/birthdays
color = dark green
readonly = true
```

### Date Formats

Customize date/time display:

```ini
[locale]
timeformat = %I:%M %p        # 12-hour format
dateformat = %m/%d/%Y        # MM/DD/YYYY
longdateformat = %A, %B %d, %Y
datetimeformat = %m/%d/%Y %I:%M %p
```

---

## Troubleshooting

### vdirsyncer sync fails

```bash
# Check status
vdirsyncer sync --verbosity=DEBUG

# Reset sync state (use with caution)
rm -rf ~/.local/share/vdirsyncer/status/
vdirsyncer sync
```

### khal shows no events

```bash
# Verify calendar paths exist
khal printcalendars

# Check if calendar files have content
ls -la ~/.local/share/khal/calendars/*/

# Rebuild cache
rm -rf ~/.local/share/khal/khal.db
khal list today
```

### Duplicate events after sync

```bash
# This usually means UID conflicts
# Check vdirsyncer config for proper collection mapping
vdirsyncer sync --verbosity=DEBUG

# May need to delete duplicates manually in ikhal
```

### Permission errors

```bash
# Fix permissions
chmod 700 ~/.config/khal
chmod 700 ~/.config/vdirsyncer
chmod 600 ~/.config/vdirsyncer/config
```

---

## Automation Examples

### Daily Agenda Email

```bash
#!/bin/bash
# Send daily agenda via email

AGENDA=$(khal list today tomorrow)

if [ -n "$AGENDA" ]; then
    echo "$AGENDA" | mail -s "Today's Agenda" user@example.com
fi
```

### Sync on Network Change

```bash
# Add to NetworkManager dispatcher or similar
#!/bin/bash
# /etc/NetworkManager/dispatcher.d/vdirsyncer-sync

if [ "$2" = "up" ]; then
    su - username -c "vdirsyncer sync" &
fi
```

### Notification Script

```bash
#!/bin/bash
# Check for upcoming events and send notifications

EVENTS=$(khal list --format "{start-time} {title}" today | head -5)

if [ -n "$EVENTS" ]; then
    notify-send "Upcoming Events" "$EVENTS"
fi
```

---

## Integration with Other Tools

### tmux Status Bar

Add to `.tmux.conf`:

```bash
set -g status-right '#(khal list today | head -1 | cut -c 1-40)'
```

### Waybar/i3status

```json
"custom/calendar": {
    "exec": "khal list today | head -1",
    "interval": 300,
    "format": "📅 {}"
}
```

---

## Best Practices

1. **Regular Syncing**: Set up automatic vdirsyncer syncing via cron or systemd timer
2. **Backup**: Periodically backup `~/.local/share/khal/calendars/`
3. **Multiple Calendars**: Use separate calendars for work, personal, birthdays, etc.
4. **Consistent Format**: Use ISO date format (YYYY-MM-DD) for clarity
5. **Event Templates**: Create shell aliases for common event types
6. **Time Zones**: Always specify time zones for events with remote participants
7. **Conflict Resolution**: Review sync conflicts promptly in ikhal

---

## Additional Resources

- khal documentation: https://khal.readthedocs.io/
- vdirsyncer documentation: https://vdirsyncer.pimutils.org/
- CalDAV specification: https://datatracker.ietf.org/doc/html/rfc4791
- For provider-specific configs: [references/providers.md](references/providers.md)
