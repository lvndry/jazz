---
name: calendar
description: Manage calendars using khal CLI and vdirsyncer for CalDAV providers, or gcalcli for Google Calendar. Use when the user wants to view, create, edit, or delete calendar events, sync calendars, manage multiple calendars, or mentions "calendar", "event", "appointment", "meeting", "schedule", "CalDAV", "khal", "vdirsyncer", "gcalcli", "Google Calendar".
---

# Calendar Management

Two backends:
- **khal + vdirsyncer** for CalDAV providers (Nextcloud, iCloud, Fastmail, Radicale…).
- **gcalcli** for Google Calendar — Google's CalDAV endpoint rejects the discovery handshake and app-password Basic Auth, so khal/vdirsyncer cannot be used for it.

## khal (non-Google CalDAV)
- `vdirsyncer sync` first to refresh local data. Skip entirely if this is a Google-only setup (no working vdirsyncer pair). If `khal printcalendars` errors or lists nothing, fall back to gcalcli.
- `khal list today|week|<range>` — read. `khal list --format "{start} {end} {title}"` for parsing.
- `khal new "Team meeting tomorrow 3pm-4pm"` — natural language, or structured:
  `khal new -a work 2026-02-15 14:00 1h "Sprint Planning" --location "Room A"`.
- `khal search "meeting"` returns UIDs → `khal edit <uid>` / `khal delete <uid>`.
- `khal printcalendars` lists calendars; `-a <cal>` targets one.
- Setup/config details: see references/providers.md.

## gcalcli (Google)
Isolation is by data dir only — there is no `--account` flag. Each account needs its own `$XDG_DATA_HOME` (e.g. `~/.local/share/gcalcli-account-a`); reusing one dir overwrites the previous account's cache.

**Before OAuth**, check for an already-configured account — gcalcli's cache is `$XDG_DATA_HOME/gcalcli/oauth`, and many deployments set `$XDG_DATA_HOME` to a non-default path, so an empty `~/.local/share` does NOT mean no account exists:
`find "${XDG_DATA_HOME:-$HOME/.local/share}"/.. -maxdepth 2 -iname "gcalcli*"`.
Use a found dir directly: `XDG_DATA_HOME=<dir> gcalcli agenda`.

**One-time OAuth client** (per deployment): Google Cloud Console → enable Calendar API → OAuth consent (External, add each user as test user) → create a Desktop-app client ID/secret. Reuse the same client across all accounts.

**Per account** (repeat for each): `XDG_DATA_HOME=~/.local/share/gcalcli-account-a gcalcli --client-id "$CID" --client-secret "$CSEC" init`.
If `init` hangs after Allow (browser opens two connections, the callback server grabs the wrong one), recover manually per account:
1. Open `https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=$CID&redirect_uri=http://localhost:8080&scope=https://www.googleapis.com/auth/calendar&access_type=offline&prompt=select_account%20consent&login_hint=$EMAIL`. `prompt=select_account consent` is REQUIRED with >1 account, or Google silently reuses the logged-in account and writes the wrong token.
2. Copy `code` from the failed `http://localhost:8080/?...&code=...` URL.
3. `curl -s -X POST https://oauth2.googleapis.com/token -d "code=$CODE" -d "client_id=$CID" -d "client_secret=$CSEC" -d "redirect_uri=http://localhost:8080" -d "grant_type=authorization_code"`.
4. Write JSON `{access_token, client_id, client_secret, refresh_token, token_uri:"https://oauth2.googleapis.com/token", scopes:[...]}` to `$XDG_DATA_HOME/gcalcli/oauth`.
5. Verify: `XDG_DATA_HOME=~/.local/share/gcalcli-account-a gcalcli list` shows THAT account's calendars, not another's.

**Usage** (set `XDG_DATA_HOME` on every call; one command per account — never a `for` loop, it defeats the command allowlist):
```
XDG_DATA_HOME=~/.local/share/gcalcli-account-a gcalcli agenda
XDG_DATA_HOME=~/.local/share/gcalcli-account-a gcalcli quick "Lunch with John tomorrow at noon"
XDG_DATA_HOME=~/.local/share/gcalcli-account-a gcalcli add --title "Sprint" --where "Room A" --when "2026-02-15 14:00" --duration 1h
```

**gcalcli pitfalls:**
- Date args are **dates, not day counts**: `gcalcli agenda 30` means the 30th of this month, not "next 30 days"; `agenda 120` is invalid and silently shows "No Events Found". Always give a real range, e.g. `gcalcli agenda today "120 days"`.
- `search` matches **whole words**, not substrings: `search podo` finds nothing for "podologue". Search the full word, and confirm against a date-ranged `agenda` before declaring the calendar empty.
- Issue one plain command per account (env-var prefixes are fine); a shell loop keys approval off `for` and triggers a manual prompt every turn.
