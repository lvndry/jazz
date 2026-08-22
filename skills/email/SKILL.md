---
name: email
description: Manage emails via Himalaya CLI. Use when the user wants to read, send, search, or organize emails. Triggers on "email", "inbox", "send email", "check mail", "reply to", "forward", or mentions of Gmail, Outlook, iCloud, Proton Mail.
---

# Email Management

Manage emails using [Himalaya CLI](https://github.com/pimalaya/himalaya) - a powerful command-line email client supporting IMAP, SMTP, Maildir, and Notmuch backends.

## Agent Usage (Power User Patterns)

**When using this skill as an agent**, run commands via `execute_command`. Prefer these patterns:

0. **Install and set up if needed.** Run [Prerequisites Check](#prerequisites-check) before the first Himalaya command. If `himalaya` is missing, fetch the live README and install it. If no account is configured, walk the user through [Account Setup](#account-setup), then continue the original request (check mail, etc.). Do not stop at "go install Himalaya".

1. **Always use `--output json`** when you need to parse results (subject, from, id). Example:
   ```bash
   himalaya envelope list --folder INBOX --page-size 20 --output json | jq '.[] | {id, subject, from, date}'
   ```

2. **Non-interactive send**: `message write` opens `$EDITOR`. For automation, pipe a full RFC-style message to `himalaya template send` (if available), or use a temp file:
   ```bash
   echo -e "To: recipient@example.com\nSubject: Subject\n\nBody text" | himalaya template send
   ```
   If `template send` is not available, use `himalaya message write --to "recipient" --subject "Subject"` and note that it may open an editor—check `himalaya --help` for your version.

3. **Extract message IDs** for follow-up actions: `himalaya envelope list --output json | jq -r '.[].id'`

4. **Batch operations**: Pass multiple IDs to move/delete: `himalaya message move <id1> <id2> <id3> --folder "Archives"`

5. **Check before acting**: Run `himalaya account list` and `himalaya folder list` first if the user has multiple accounts or folders.

6. **Use `--account <name>`** when the user has multiple accounts (e.g., `himalaya --account work envelope list`).

## Prerequisites Check

Before any email operation:

1. Check whether Himalaya is on PATH:

   ```bash
   command -v himalaya
   ```

2. **If it is missing, install it.** Do not just tell the user to install it. Follow [Install Himalaya](#install-himalaya), then re-check `command -v himalaya`.

3. Check configuration:

   ```bash
   himalaya account list
   ```

   If no accounts → walk them through [Account Setup](#account-setup), then continue what they asked. Do not invent credentials. The wizard needs a real TTY; do not run it via `execute_command`. In a headless run, write a one-line failure note and stop.

---

## Install Himalaya

Himalaya is a third-party CLI ([pimalaya/himalaya](https://github.com/pimalaya/himalaya)). Install methods change; **fetch the live README and follow its Installation section** rather than memorizing this page.

1. Fetch the README with `web_fetch` (or `http_request` GET if `web_fetch` is unavailable):
   `https://raw.githubusercontent.com/pimalaya/himalaya/master/README.md`
   If that fails, try `https://github.com/pimalaya/himalaya`. Read the **Installation** section. If fetch is unavailable, use the table below.

2. Detect the host (`uname -s`) and which of `brew`, `pacman`, `scoop`, `nix`, `cargo` exist.

3. Install using the README method that matches, in this preference order:

   | Host                | Typical command (confirm against the README)                                                            |
   | ------------------- | ------------------------------------------------------------------------------------------------------- |
   | macOS with Homebrew | `brew install himalaya`                                                                                 |
   | Arch                | `pacman -S himalaya`                                                                                    |
   | Windows with Scoop  | `scoop install himalaya`                                                                                |
   | Nix                 | `nix profile install github:pimalaya/himalaya`                                                          |
   | Any OS, no root     | `curl -sSL https://raw.githubusercontent.com/pimalaya/himalaya/master/install.sh \| PREFIX=~/.local sh` |
   | Cargo last resort   | `cargo install --locked --git https://github.com/pimalaya/himalaya.git`                                 |

4. **Never `sudo` the installer** unless the user explicitly asks. Prefer the user-prefix install (`PREFIX=~/.local`).

5. If you installed to `~/.local/bin` and `command -v himalaya` still fails, prepend that directory for the rest of this session. Each `execute_command` is a fresh shell, so include it on later commands:

   ```bash
   export PATH="$HOME/.local/bin:$PATH"
   command -v himalaya
   ```

   Tell the user to add `~/.local/bin` to PATH permanently if it is not already.

6. Verify with `himalaya --version` (or `himalaya -V`). If a later command fails with unknown flags, re-read the README Usage section and `himalaya --help` — prefer those over this skill's examples.

If fetch and every install method fail, tell the user what you tried and point them at https://github.com/pimalaya/himalaya#installation.

---

## Account Setup

Himalaya with no config starts an interactive TTY wizard. **Do not run bare `himalaya` via `execute_command`** — it will hang waiting for a terminal. Guide the user instead, then continue the original request.

Fetch the live README Configuration section if the wizard flags have changed: `https://raw.githubusercontent.com/pimalaya/himalaya/master/README.md`. Prefer that over this page.

### First-run (interactive chat)

When `himalaya account list` is empty or errors because nothing is configured — e.g. the user just asked "check my latest emails":

1. Say in one or two lines that mail isn't set up yet, and you will walk them through it so you can then do what they asked. Setup is part of the request, not a detour.
2. Ask the provider with `ask_user_question`: Gmail, Outlook / Microsoft 365, iCloud, Proton Mail, Fastmail, other IMAP.
3. Load [references/providers.md](references/providers.md) for that provider. Tell them the one thing they need *before* the wizard:
   - **Gmail** — App Password at https://myaccount.google.com/apppasswords (2-Step Verification must be on).
   - **Outlook** — OAuth 2.0; basic auth is retired.
   - **iCloud** — app-specific password; IMAP login is the local-part only (`johnappleseed`, not the full address).
   - **Proton Mail** — Proton Bridge running locally; the password is the Bridge password.
   - **Fastmail** — app password for IMAP/SMTP, or an API token for JMAP.
4. Ask them to run the wizard in **their** terminal (a new tab is fine):

   ```bash
   himalaya
   ```

   If their version has `himalaya account configure <name>`, that works too. Prefer whatever `himalaya --help` and the live README show. The wizard asks for an email address and discovers IMAP/SMTP. **Never ask them to paste a password into this chat.** Secrets belong in the wizard, `pass`, or `secret-tool`.
5. When they say the wizard finished, re-run `himalaya account list` (and `himalaya account check` if it exists). If it works, immediately continue the original request. Do not wait to be asked again.

### Headless / unattended

Do not start a wizard. Write a one-line failure that Himalaya has no account configured, and stop.

### Writing config yourself

If they already use `pass` (or similar) and want you to write `~/.config/himalaya/config.toml`, fetch the live README Configuration section — the TOML shape changes across versions — and `load_skill_section` for [references/providers.md](references/providers.md). Never put a raw password in the file or in chat.

### Provider-Specific Notes

| Provider        | Special Requirements                         |
| --------------- | -------------------------------------------- |
| **Gmail**       | Requires App Password or OAuth 2.0 setup     |
| **Outlook**     | Works with password or OAuth 2.0             |
| **iCloud**      | IMAP login is username only (not full email) |
| **Proton Mail** | Requires Proton Bridge running locally       |

Many providers use the same app-specific password for both email and calendar. Store credentials in `pass` with consistent naming (e.g., `google/app-password`, `icloud/app-password`) to reuse them across both skills. For multiple accounts, use a hierarchical structure (e.g., `google/personal/app-password`) — the `/` creates folders.

For detailed provider configs, see [references/providers.md](references/providers.md)

---

## Common Operations

### List Emails

```bash
# List recent emails in INBOX
himalaya envelope list

# List from specific folder
himalaya envelope list --folder "Archives"

# List with specific account
himalaya envelope list --account gmail

# Paginate results
himalaya envelope list --page 2 --page-size 20
```

### Read Email

```bash
# Read by ID
himalaya message read <id>

# Read in plain text (no HTML)
himalaya message read <id> --plain

# Read headers only
himalaya message read <id> --headers
```

### Send Email

```bash
# Compose new email (opens $EDITOR)
himalaya message write

# Send with pre-filled fields
himalaya message write --to "recipient@example.com" --subject "Hello"

# Reply to a message
himalaya message reply <id>

# Reply all
himalaya message reply <id> --all
```

### Search Emails

```bash
# NOTE: `envelope list` does NOT support a `--query` flag.
# Any trailing arguments are interpreted as the search query.
# Put options FIRST (e.g., --folder/--output/--page-size), then query tokens.
# NOTE: There is no `--max-size` flag. To limit results, use `--page-size` (and optionally `--page`).


# Basic filters (direct Himalaya query syntax)

# Search by subject
himalaya envelope list --folder INBOX subject "meeting"

# Search by sender
himalaya envelope list --folder INBOX from "boss@company.com"

# Unread (not seen)
himalaya envelope list --folder INBOX not flag seen

# Search by exact date (YYYY-MM-DD or YYYY/MM/DD)
himalaya envelope list --folder INBOX date 2026-02-09

# Combine filters with and/or (quote the expression to keep it as one arg)
himalaya envelope list --folder INBOX "from client@example.com and subject invoice and not flag seen"

# ---------------------------------------------------------------------------
# Shell-level helpers (useful patterns for LLMs)
# ---------------------------------------------------------------------------

# Count emails received TODAY in INBOX
# 1) List all envelopes
# 2) Skip the header lines
# 3) Grep for today's ISO date string
# 4) Count lines
TODAY=$(date +%Y-%m-%d)
himalaya envelope list --folder INBOX \
  | tail -n +3 \
  | grep "${TODAY}" \
  | wc -l

# Count unread emails in INBOX
himalaya envelope list --folder INBOX not flag seen \
  | tail -n +3 \
  | wc -l

# Show latest N emails in INBOX (for quick inspection)
# Use pagination flags (not `tail`) to reliably fetch only N messages.
himalaya envelope list --folder INBOX --page 1 --page-size 10

# Show latest N *unread* emails
himalaya envelope list --folder INBOX --page 1 --page-size 10 not flag seen
```

### Manage Folders

```bash
# List folders
himalaya folder list

# Create folder
himalaya folder create "Projects/ClientA"

# Move message to folder
himalaya message move <id> --folder "Archives"

# Copy message
himalaya message copy <id> --folder "Important"
```

### Manage Flags

```bash
# Mark as read
himalaya flag add <id> seen

# Mark as unread
himalaya flag remove <id> seen

# Star/flag message
himalaya flag add <id> flagged

# Delete (move to trash)
himalaya message delete <id>
```

### Switch Between Accounts

```bash
# Use specific account for any command
himalaya --account work envelope list
himalaya --account personal message write
```

### Check All Accounts

```bash
# List configured accounts
himalaya account list

# Check unread across accounts
for account in $(himalaya account list --output json | jq -r '.[].name'); do
  echo "=== $account ==="
  himalaya --account "$account" envelope list --page-size 5 not flag seen
done
```

## Output Formats

Himalaya supports JSON output for scripting:

```bash
# JSON output
himalaya envelope list --output json

# Parse with jq
himalaya envelope list --output json | jq '.[].subject'
```

---

## Troubleshooting

### Connection Issues

```bash
# Enable debug logging
RUST_LOG=debug himalaya envelope list

# Full trace
himalaya --debug envelope list
```

### Common Errors

| Error                   | Solution                                          |
| ----------------------- | ------------------------------------------------- |
| "Account not found"     | Run `himalaya account configure <name>`           |
| "Authentication failed" | Check password/app password, regenerate if needed |
| "Connection refused"    | Check IMAP/SMTP host and port settings            |
| "Certificate error"     | Check TLS settings in config                      |

### Reset Configuration

**Config file location:** `~/.config/himalaya/config.toml` (or `$XDG_CONFIG_HOME/himalaya/config.toml`)

```bash
# View current config
cat ~/.config/himalaya/config.toml

# Edit config manually
$EDITOR ~/.config/himalaya/config.toml

# Reconfigure account interactively
himalaya account configure <name>

# Use alternative config file
himalaya --config /path/to/custom/config.toml envelope list
```

**Environment variable override:**

```bash
export HIMALAYA_CONFIG=~/.config/himalaya/custom-config.toml
himalaya envelope list
```

---

## Composing Emails

Himalaya uses your `$EDITOR` for composing. The format is:

```
To: recipient@example.com
Cc: other@example.com
Subject: Your subject here

Your message body here.
```

### Adding Attachments (MML Syntax)

---

## Searching emails

Himalaya’s search uses a **positional query expression**, not a `--query` flag.

### Date filters

```bash
# Envelopes strictly after a given date
himalaya envelope list "after 2026-02-10"

# Envelopes strictly before a given date
himalaya envelope list "before 2026-02-10"

# All emails received today (from local date)
himalaya envelope list "after $(date +%Y-%m-%d)"
```

### Other common filters

```bash
# From a specific sender
himalaya envelope list "from me@example.com"

# To a specific recipient
himalaya envelope list "to someone@example.com"

# Subject contains words
himalaya envelope list "subject report"

# Combine filters (AND semantics)
himalaya envelope list "from me@example.com and subject report"
```

---

## Quick Reference

| Task        | Command                                                |
| ----------- | ------------------------------------------------------ |
| Check inbox | `himalaya envelope list`                               |
| Read email  | `himalaya message read <id>`                           |
| Compose new | `himalaya message write`                               |
| Reply       | `himalaya message reply <id>`                          |
| Search      | `himalaya envelope list "from me@example.com"`         |
| Mark read   | `himalaya flag add <id> seen`                          |
| Delete      | `himalaya message delete <id>`                         |
| Move        | `himalaya message move --folder SOURCE TARGET <id...>` |

- For provider-specific setup, see [references/providers.md](references/providers.md)
- Official docs: https://github.com/pimalaya/himalaya
