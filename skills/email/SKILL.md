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

| Provider | Special Requirements |
|----------|---------------------|
| **Gmail** | Requires App Password or OAuth 2.0 setup |
| **Outlook** | Works with password or OAuth 2.0 |
| **iCloud** | IMAP login is username only (not full email) |
| **Proton Mail** | Requires Proton Bridge running locally |

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

# Forward
himalaya message forward <id>
```

### Search Emails

```bash
# Search by subject
himalaya envelope list --query "subject:meeting"

# Search by sender
himalaya envelope list --query "from:boss@company.com"

# Search by date
himalaya envelope list --query "since:2024-01-01"

# Combined search
himalaya envelope list --query "from:client subject:invoice unseen"
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

### Attachments

```bash
# List attachments
himalaya attachment list <id>

# Download attachment
himalaya attachment download <id> <attachment-id>

# Download all attachments
himalaya attachment download <id> --all
```

---

## Multi-Account Workflows

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
  himalaya --account "$account" envelope list --query "unseen" --page-size 5
done
```

---

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

| Error | Solution |
|-------|----------|
| "Account not found" | Run `himalaya account configure <name>` |
| "Authentication failed" | Check password/app password, regenerate if needed |
| "Connection refused" | Check IMAP/SMTP host and port settings |
| "Certificate error" | Check TLS settings in config |

### Reset Configuration

Config file location: `~/.config/himalaya/config.toml`

```bash
# View current config
cat ~/.config/himalaya/config.toml

# Reconfigure account
himalaya account configure <name>
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

```
To: recipient@example.com
Subject: Document attached

Please find the document attached.

<#part filename=/path/to/document.pdf><#/part>
```

### Inline Images

```
To: recipient@example.com
Subject: Screenshot

Here's the screenshot:
<#part disposition=inline filename=/path/to/image.png><#/part>
```

---

## Quick Reference

| Task | Command |
|------|---------|
| Check inbox | `himalaya envelope list` |
| Read email | `himalaya message read <id>` |
| Compose new | `himalaya message write` |
| Reply | `himalaya message reply <id>` |
| Search | `himalaya envelope list --query "..."` |
| Mark read | `himalaya flag add <id> seen` |
| Delete | `himalaya message delete <id>` |
| Move | `himalaya message move <id> --folder "..."` |

## Additional Resources

- For provider-specific setup, see [references/providers.md](references/providers.md)
- Official docs: https://github.com/pimalaya/himalaya
