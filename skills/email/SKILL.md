---
name: email
description: Manage emails via Himalaya CLI. Use when the user wants to read, send, search, or organize emails. Triggers on "email", "inbox", "send email", "check mail", "reply to", "forward", or mentions of Gmail, Outlook, iCloud, Proton Mail.
---

# Email Management

Manage emails using [Himalaya CLI](https://github.com/pimalaya/himalaya) - a powerful command-line email client supporting IMAP, SMTP, Maildir, and Notmuch backends.

> **Config format note (Himalaya v2.x).** Himalaya v2 reorganized the config from the old
> `backend.*` / `message.send.backend.*` schema into per-protocol tables (`[accounts.x.imap]`,
> `[accounts.x.smtp]`, `[accounts.x.jmap]`). A v1 config silently loads with **zero backends**, so
> every command fails with `No backend matching \`auto\` is configured`. If you see that error, the
> config is in the wrong format — see [references/providers.md](references/providers.md) for the v2
> shape. `account list` shows the resolved backends per account; use it to confirm.

## Agent Usage (Power User Patterns)

**When using this skill as an agent**, run commands via `execute_command`. Prefer these patterns:

0. **Install and set up if needed.** Run [Prerequisites Check](#prerequisites-check) before the first Himalaya command. If `himalaya` is missing, fetch the live README and install it. If no account is configured, walk the user through [Account Setup](#account-setup), then continue the original request (check mail, etc.). Do not stop at "go install Himalaya".

1. **Always use `--json`** (the global flag) when you need to parse results (subject, from, id):
   ```bash
   himalaya envelope list -m INBOX -s 20 --json | jq '.envelopes[] | {id, subject, from, date}'
   ```
   Note: in v2 the flag is the **global `--json`**, not `--output json`. `envelope list` emits
   `{"envelopes":[...]}`; `account list` emits `{"accounts":[...]}`.

2. **Non-interactive send** uses `message write` with flags and `--send` (no editor):
   ```bash
   himalaya message write --to "recipient@example.com" --subject "Subject" --body "Body text" --send
   ```
   Or feed the body via stdin:
   ```bash
   printf 'Body text' | himalaya message write --to "recipient@example.com" --subject "Subject" --send
   ```
   `--save <MAILBOX>` appends a copy (e.g. Sent) alongside `--send`.

3. **Extract message IDs** for follow-up actions:
   ```bash
   himalaya envelope list -m INBOX -s 20 --json | jq -r '.envelopes[].id'
   ```

4. **Batch operations** — pass multiple IDs; move/copy use `--to` (and optional `--from`):
   ```bash
   himalaya message move --to "Archives" <id1> <id2> <id3>
   himalaya message copy --to "Important" <id1> <id2>
   ```

5. **Check before acting**: Run `himalaya account list` first if the user has multiple accounts or folders. Folders/mailboxes are listed with `himalaya mailbox list` (v2 renamed `folder` to `mailbox`).

6. **Use `-a <name>`** (not `--account`) when the user has multiple accounts:
   ```bash
   himalaya -a gmail envelope list -m INBOX
   ```

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

   If it errors with `No backend matching \`auto\` is configured`, the config is in the old
   (v1) format — don't treat it as "no account". Open the config and migrate it to the v2
   per-protocol schema (see [references/providers.md](references/providers.md)). If `account list`
   is truly empty → walk them through [Account Setup](#account-setup). Do not invent credentials.
   The wizard needs a real TTY; do not run it via `execute_command`. In a headless run, write a
   one-line failure note and stop.

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

6. Verify with `himalaya --version` (or `himalaya -V`). If a later command fails with unknown flags, re-read `himalaya <command> --help` — prefer that over this skill's examples, since flags changed in v2.

If fetch and every install method fail, tell the user what you tried and point them at https://github.com/pimalaya/himalaya#installation.

---

## Account Setup

Himalaya v2 has **no `account configure` subcommand** (it was removed). To add an account you
write the TOML directly — see [references/providers.md](references/providers.md) for the v2 schema,
or run bare `himalaya` to start the (interactive, TTY-only) setup wizard. **Do not run bare
`himalaya` via `execute_command`** — it will hang waiting for a terminal. Guide the user instead,
then continue the original request.

When `himalaya account list` shows no accounts — e.g. the user just asked "check my latest emails":

1. Say in one or two lines that mail isn't set up yet, and you will walk them through it so you can then do what they asked. Setup is part of the request, not a detour.
2. Ask the provider with `ask_user_question`: Gmail, Outlook / Microsoft 365, iCloud, Proton Mail, Fastmail, other IMAP.
3. Load [references/providers.md](references/providers.md) for that provider. Tell them the one thing they need *before* writing config:
   - **Gmail** — App Password at https://myaccount.google.com/apppasswords (2-Step Verification must be on).
   - **Outlook** — OAuth 2.0; basic auth is retired.
   - **iCloud** — app-specific password; IMAP login is the local-part only (`johnappleseed`, not the full address).
   - **Proton Mail** — Proton Bridge running locally; the password is the Bridge password.
   - **Fastmail** — app password for IMAP/SMTP, or an API token for JMAP.
4. Write the account block into `~/.config/himalaya/config.toml` (v2 schema). For passwords prefer
   `pass`/`security`/keyring over a raw value; **never paste a password into chat** — secrets
   belong in the wizard, `pass`, `secret-tool`, or the macOS Keychain. If OAuth is needed, the user
   must run the auth flow in their own terminal.
5. When config is written, re-run `himalaya account list` (and `himalaya account check <name>` if it exists). If it shows `imap, smtp` backends, immediately continue the original request. Do not wait to be asked again.

### Headless / unattended
Do not start a wizard. Write a one-line failure that Himalaya has no account configured, and stop.

For detailed provider configs, see [references/providers.md](references/providers.md)

---

## Common Operations

All commands below are for **Himalaya v2.x**. The mailbox flag is `-m/--mailbox` and is required for
message commands unless `mailbox.alias.inbox` is set; account selection is `-a/--account`; JSON is
the global `--json`.

### List Emails

```bash
# List recent emails in INBOX (most recent first, page 1)
himalaya envelope list -m INBOX -s 20

# List from a specific mailbox
himalaya envelope list -m "[Gmail]/All Mail" -s 20

# List with a specific account
himalaya -a gmail envelope list -m INBOX -s 20

# Paginate
himalaya envelope list -m INBOX -p 2 -s 20

# JSON for parsing
himalaya envelope list -m INBOX -s 20 --json
```

Note: `envelope list` does **not** accept a positional search query in v2 — use `envelope search`
(see [Searching emails](#searching-emails)) or filter client-side.

### Read Email

```bash
# Read by ID (prints a header block + walks MIME parts)
himalaya message read <id> -m INBOX

# Mark seen while reading
himalaya message read <id> -m INBOX --seen

# Raw RFC 5322 bytes (pipe into a renderer / grep for headers)
himalaya message read <id> -m INBOX --raw

# Structured parse as JSON
himalaya message read <id> -m INBOX --json
```

There is no `--plain` or `--headers` flag in v2; use `--raw` (then `grep`) or `--json` to inspect
headers selectively.

### Send Email

```bash
# Compose + send non-interactively (writes RFC5322 then sends via SMTP/JMAP)
himalaya message write --to "recipient@example.com" --subject "Hello" --body "Body" --send
himalaya message write --to "a@x.com,b@y.com" --subject "Hello" --body "Body" --send --save "Sent"

# Body from a file
himalaya message write --to "recipient@example.com" --subject "S" --body-file /tmp/body.txt --send

# Reply to a message (opens $EDITOR unless you also pass --body)
himalaya message reply <id> -m INBOX
himalaya message reply <id> -m INBOX --all --send
```

`message write` with flags does not open an editor; only `message reply`/`forward` without a body do.

### Search Emails

```bash
# Search uses the `envelope search` subcommand + a positional query DSL
himalaya envelope search -m INBOX "from google"
himalaya envelope search -m INBOX "subject report"
himalaya envelope search -m INBOX "from boss@company.com and subject invoice"
himalaya envelope search -m INBOX "not flag seen"        # unread only
himalaya envelope search -m INBOX "after 2026-08-01"
himalaya envelope search -m INBOX "date 2026-08-09"
```

Conditions: `date <yyyy-mm-dd>`, `after <yyyy-mm-dd>`, `before <yyyy-mm-dd>`, `from <pattern>`,
`to <pattern>`, `subject <pattern>`, `body <pattern>`, `flag <seen|answered|flagged|draft>`.
Combine with `and` / `or`; quote the whole expression.

### Manage Mailboxes (was `folder` in v1)

```bash
# List mailboxes
himalaya mailbox list

# Move message(s) to a mailbox
himalaya message move --to "Archives" <id1> <id2>
himalaya message move --from INBOX --to "Archives" <id>

# Copy message(s)
himalaya message copy --to "Important" <id>
```

There is **no `mailbox create`** in this build; create folders from a client (or use the provider's
web UI) and they appear via `mailbox list`.

### Manage Flags

```bash
# Mark as read (seen)
himalaya flag add -f seen <id>

# Mark as unread
himalaya flag remove -f seen <id>

# Star/flag message
himalaya flag add -f flagged <id>

# Delete (trash-first: moves to trash, expunges if already in trash)
himalaya message delete <id> -m INBOX
```

`flag add` / `flag remove` require `-f/--flag` (repeatable). Delete requires a mailbox (`-m`).

### Switch Between Accounts

```bash
# Use specific account for any command
himalaya -a work envelope list -m INBOX
himalaya -a personal message write --to ... --send
```

### Check All Accounts

```bash
# List configured accounts (with resolved backends)
himalaya account list

# Check unread across accounts
for account in $(himalaya account list --json | jq -r '.accounts[].name'); do
  echo "=== $account ==="
  himalaya -a "$account" envelope search -m INBOX "not flag seen" -s 5
done
```

## Output Formats

Himalaya v2 emits JSON with the global `--json` flag (not `--output json`):

```bash
# JSON output
himalaya envelope list -m INBOX -s 20 --json
himalaya account list --json

# Parse with jq
himalaya envelope list -m INBOX -s 20 --json | jq '.envelopes[].subject'
himalaya account list --json | jq -r '.accounts[].name'
```

---

## Troubleshooting

### Connection Issues

```bash
# Enable debug logging
RUST_LOG=debug himalaya envelope list -m INBOX
```

### Common Errors

| Error                                          | Solution                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `No backend matching \`auto\` is configured`   | Config is in the old v1 format. Migrate to the v2 per-protocol schema — see `references/providers.md`. |
| `Mailbox is required` / `mailbox.alias.inbox` | Pass `-m INBOX` (or set `mailbox.alias.inbox` in config).                |
| `Invalid credentials` (IMAP AUTHENTICATE)     | App password wrong/expired or 2-Step off. Regenerate at the provider; for Gmail, https://myaccount.google.com/apppasswords. |
| `Account not found`                            | Use the exact account name from `himalaya account list`.                 |
| `Connection refused` / `Certificate error`     | Check IMAP/SMTP host/port/TLS in config.                                 |

### Reset Configuration

**Config file location:** `~/.config/himalaya/config.toml` (or `$XDG_CONFIG_HOME/himalaya/config.toml`)

```bash
# View current config
cat ~/.config/himalaya/config.toml

# Edit config manually
$EDITOR ~/.config/himalaya/config.toml

# Validate an account's connection (v2; replaces the removed `account configure`)
himalaya account check <name>

# Use alternative config file
himalaya -c /path/to/custom/config.toml envelope list -m INBOX
```

**Environment variable override:**

```bash
export HIMALAYA_CONFIG=~/.config/himalaya/custom-config.toml
himalaya envelope list -m INBOX
```

---

## Composing Emails

Himalaya uses `message write` for composition. Without body flags it opens `$EDITOR` with an
RFC-style draft (`To:`, `Cc:`, `Subject:`, blank line, body). With `--to/--subject/--body` it
composes and prints the RFC 5322 bytes; add `--send` to deliver and/or `--save <MAILBOX>` to keep a
copy.

```
To: recipient@example.com
Cc: other@example.com
Subject: Your subject here

Your message body here.
```

### Adding Attachments (MML Syntax)
Pipe MML through `mml` then into `himalaya message write` (see `himalaya message write --help`).

---

## Searching emails

Himalaya's search lives in the **`envelope search`** subcommand and a positional query DSL (v2
removed the inline query from `envelope list`).

### Date filters

```bash
# Envelopes strictly after a given date
himalaya envelope search -m INBOX "after 2026-02-10"

# Envelopes strictly before a given date
himalaya envelope search -m INBOX "before 2026-02-10"

# All emails received today (from local date)
himalaya envelope search -m INBOX "after $(date +%Y-%m-%d)"
```

### Other common filters

```bash
# From a specific sender
himalaya envelope search -m INBOX "from me@example.com"

# To a specific recipient
himalaya envelope search -m INBOX "to someone@example.com"

# Subject contains words
himalaya envelope search -m INBOX "subject report"

# Combine filters (AND semantics)
himalaya envelope search -m INBOX "from me@example.com and subject report"
```

---

## Quick Reference

| Task        | Command                                                              |
| ----------- | ------------------------------------------------------------------- |
| Check inbox | `himalaya envelope list -m INBOX -s 20`                             |
| Read email  | `himalaya message read <id> -m INBOX`                               |
| Compose new | `himalaya message write --to ... --subject ... --body ... --send`   |
| Reply       | `himalaya message reply <id> -m INBOX`                              |
| Search      | `himalaya envelope search -m INBOX "from me@example.com"`           |
| Mark read   | `himalaya flag add -f seen <id>`                                    |
| Delete      | `himalaya message delete <id> -m INBOX`                             |
| Move        | `himalaya message move --to <MBOX> <id...>`                         |
| List boxes  | `himalaya mailbox list`                                             |

- For provider-specific setup, see [references/providers.md](references/providers.md)
- Official docs: https://github.com/pimalaya/himalaya
