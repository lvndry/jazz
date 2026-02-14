---
name: calendar
description: Manage calendars using khal CLI and vdirsyncer. Use when the user wants to view, create, edit, or delete calendar events, sync calendars with CalDAV servers, manage multiple calendars, or mentions "calendar", "event", "appointment", "meeting", "schedule", "CalDAV", "khal", "vdirsyncer".
---

# Calendar Management

Manage calendars using [khal](https://github.com/pimutils/khal) - a standards-based CLI calendar application, and [vdirsyncer](https://github.com/pimutils/vdirsyncer) - a tool for synchronizing calendars with CalDAV servers.

## Agent Usage (Power User Patterns)

**When using this skill as an agent**, run commands via `execute_command`. Prefer these patterns:

1. **Sync before read**: Run `vdirsyncer sync` first to ensure local data is up to date, especially for remote calendars.

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

| Provider            | CalDAV URL                                         | Notes                              |
| ------------------- | -------------------------------------------------- | ---------------------------------- |
| **Google Calendar** | `https://apidata.googleusercontent.com/caldav/v2/` | Requires App Password or OAuth 2.0 |
| **Nextcloud**       | `https://nextcloud.example.com/remote.php/dav/`    | Standard username/password         |
| **iCloud**          | `https://caldav.icloud.com/`                       | Requires app-specific password     |
| **Fastmail**        | `https://caldav.fastmail.com/dav/calendars/user/`  | Standard username/password         |
| **Radicale**        | `http://localhost:5232/`                           | Self-hosted, standard auth         |

**💡 Tip**: Most providers use the same app-specific password for both email and calendar. Store credentials in `pass` with consistent naming (e.g., `google/app-password`, `icloud/app-password`) to reuse them across both email and calendar skills. For multiple accounts, use a hierarchical structure (e.g., `google/personal/app-password`, `google/work/app-password`)—the `/` creates folders to keep things organized.

For detailed provider configurations, see [references/providers.md](references/providers.md)

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
