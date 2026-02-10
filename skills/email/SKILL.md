---
name: email
description: Manage emails via Himalaya CLI. Use when the user wants to read, send, search, or organize emails. Triggers on "email", "inbox", "send email", "check mail", "reply to", "forward", or mentions of Gmail, Outlook, iCloud, Proton Mail.
---

# Email Management

Manage emails using [Himalaya CLI](https://github.com/pimalaya/himalaya) - a powerful command-line email client supporting IMAP, SMTP, Maildir, and Notmuch backends.

## Prerequisites Check

Before any email operation, verify Himalaya is installed and configured:

```bash
# Check if installed
which himalaya

# Check if configured (lists accounts)
himalaya account list
```

If not installed → Guide through [Installation](#installation)
If no accounts → Guide through [Account Setup](#account-setup)

---

## Installation

### pre-built binary

curl -sSL https://raw.githubusercontent.com/pimalaya/himalaya/master/install.sh | PREFIX=~/.local sh

### macOS (Homebrew)

```bash
brew install himalaya
```

### Arch Linux

```bash
pacman -S himalaya
```

### Cargo (Any OS)

```bash
cargo install himalaya --locked
```

### Other Methods

Direct user to: https://github.com/pimalaya/himalaya#installation

---

## Account Setup

**Recommended approach**: Use Himalaya's built-in wizard which auto-discovers settings.

### Interactive Setup (Easiest)

```bash
# First-time setup - wizard starts automatically
himalaya

# Or configure a specific account
himalaya account configure <account-name>
```

The wizard will:

1. Ask for email address
2. Auto-discover IMAP/SMTP settings
3. Prompt for password (stored securely in system keyring)
4. Test the connection

### Provider-Specific Notes

| Provider        | Special Requirements                         |
| --------------- | -------------------------------------------- |
| **Gmail**       | Requires App Password or OAuth 2.0 setup     |
| **Outlook**     | Works with password or OAuth 2.0             |
| **iCloud**      | IMAP login is username only (not full email) |
| **Proton Mail** | Requires Proton Bridge running locally       |

**💡 Tip**: Many providers use the same app-specific password for both email and calendar. Store credentials in `pass` with consistent naming (e.g., `google/app-password`, `icloud/app-password`) to reuse them across both email and calendar skills. For multiple accounts, use a hierarchical structure (e.g., `google/personal/app-password`, `google/work/app-password`)—the `/` creates folders to keep things organized.

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

# Show last N emails in INBOX (for quick inspection)
himalaya envelope list --folder INBOX \
  | tail -n 10
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
