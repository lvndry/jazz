# Email Provider Configuration (Himalaya v2.x)

Detailed setup instructions for common email providers with Himalaya.

> **v2 config schema.** Himalaya v2 uses per-protocol tables, not the old `backend.*` /
> `message.send.backend.*` keys. A v1 config loads with **zero backends** and every command fails
> with `No backend matching \`auto\` is configured`. Use this shape:
>
> ```toml
> [accounts.example]
> email = "you@example.com"
>
> [accounts.example.imap]
> server = "imap.example.com:993"
> sasl.plain.username = "you@example.com"
> sasl.plain.password.raw = "app-password"   # or .command / .keyring
>
> [accounts.example.smtp]
> server = "smtp.example.com:465"
> sasl.plain.username = "you@example.com"
> sasl.plain.password.raw = "app-password"
> ```
>
> Password sources for `sasl.plain.password`:
> - `raw = "..."` — inline (testing only, never commit)
> - `command = "pass show google/app-password"` — runs a command, uses stdout
> - `keyring = "entry-name"` — OS keyring
>
> Config file location: `~/.config/himalaya/config.toml` (or `$XDG_CONFIG_HOME/himalaya/config.toml`).
> Validate with `himalaya account check <name>`. There is **no `account configure`** in v2 — write
> the TOML directly.

---

## Gmail

### Option 1: App Password (Recommended)

**Prerequisites:**

1. Enable IMAP in Gmail settings
2. Enable 2-Step Verification
3. Create App Password: https://myaccount.google.com/apppasswords
4. Store in `pass`: `pass insert google/app-password`

```toml
[accounts.gmail]
email = "yourname@gmail.com"

[accounts.gmail.imap]
server = "imap.gmail.com:993"
sasl.plain.username = "yourname@gmail.com"
sasl.plain.password.command = "pass show google/app-password"

[accounts.gmail.smtp]
server = "smtp.gmail.com:465"
sasl.plain.username = "yourname@gmail.com"
sasl.plain.password.command = "pass show google/app-password"
```

**Note**: This same app-specific password works for Google Calendar. Store once, use for both email and calendar skills.

### Option 1b: App Password with macOS Keychain

```toml
[accounts.gmail.imap]
server = "imap.gmail.com:993"
sasl.plain.username = "yourname@gmail.com"
sasl.plain.password.command = "security find-generic-password -a 'gmail' -s 'himalaya-gmail-imap' -w"

[accounts.gmail.smtp]
server = "smtp.gmail.com:465"
sasl.plain.username = "yourname@gmail.com"
sasl.plain.password.command = "security find-generic-password -a 'gmail' -s 'himalaya-gmail-smtp' -w"
```

Store the password once with:
```bash
security add-generic-password -a 'gmail' -s 'himalaya-gmail-imap' -w 'APP_PASSWORD' -U
security add-generic-password -a 'gmail' -s 'himalaya-gmail-smtp' -w 'APP_PASSWORD' -U
```

### Option 2: OAuth 2.0 (More Secure)

Requires creating OAuth credentials in Google Cloud Console. v2 uses `sasl.oauth2.*` blocks.

```toml
[accounts.gmail]
email = "yourname@gmail.com"

[accounts.gmail.imap]
server = "imap.gmail.com:993"
sasl.plain.username = "yourname@gmail.com"
sasl.oauth2.client-id = "YOUR_CLIENT_ID"
sasl.oauth2.client-secret.command = "pass show google/oauth2-client-secret"
sasl.oauth2.access-token.command = "pass show google/oauth2-access-token"
sasl.oauth2.refresh-token.command = "pass show google/oauth2-refresh-token"
sasl.oauth2.auth-url = "https://accounts.google.com/o/oauth2/v2/auth"
sasl.oauth2.token-url = "https://www.googleapis.com/oauth2/v3/token"
sasl.oauth2.pkce = true
sasl.oauth2.scope = "https://mail.google.com/"

[accounts.gmail.smtp]
server = "smtp.gmail.com:465"
sasl.plain.username = "yourname@gmail.com"
sasl.oauth2.client-id = "YOUR_CLIENT_ID"
sasl.oauth2.client-secret.command = "pass show google/oauth2-client-secret"
sasl.oauth2.access-token.command = "pass show google/oauth2-access-token"
sasl.oauth2.refresh-token.command = "pass show google/oauth2-refresh-token"
sasl.oauth2.auth-url = "https://accounts.google.com/o/oauth2/v2/auth"
sasl.oauth2.token-url = "https://www.googleapis.com/oauth2/v3/token"
sasl.oauth2.pkce = true
sasl.oauth2.scope = "https://mail.google.com/"
```

---

## Outlook / Microsoft 365

### Option 1: Password with pass

Store in pass: `pass insert outlook/app-password`

```toml
[accounts.outlook]
email = "yourname@outlook.com"

[accounts.outlook.imap]
server = "outlook.office365.com:993"
sasl.plain.username = "yourname@outlook.com"
sasl.plain.password.command = "pass show outlook/app-password"

[accounts.outlook.smtp]
server = "smtp-mail.outlook.com:587"
starttls = true
sasl.plain.username = "yourname@outlook.com"
sasl.plain.password.command = "pass show outlook/app-password"
```

### Option 2: OAuth 2.0

```toml
[accounts.outlook]
email = "yourname@outlook.com"

[accounts.outlook.imap]
server = "outlook.office365.com:993"
sasl.plain.username = "yourname@outlook.com"
sasl.oauth2.client-id = "YOUR_CLIENT_ID"
sasl.oauth2.client-secret.command = "pass show outlook/oauth2-client-secret"
sasl.oauth2.access-token.command = "pass show outlook/oauth2-access-token"
sasl.oauth2.refresh-token.command = "pass show outlook/oauth2-refresh-token"
sasl.oauth2.auth-url = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
sasl.oauth2.token-url = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
sasl.oauth2.pkce = true
sasl.oauth2.scopes = ["https://outlook.office.com/IMAP.AccessAsUser.All", "https://outlook.office.com/SMTP.Send"]

[accounts.outlook.smtp]
server = "smtp-mail.outlook.com:587"
starttls = true
sasl.plain.username = "yourname@outlook.com"
sasl.oauth2.client-id = "YOUR_CLIENT_ID"
sasl.oauth2.client-secret.command = "pass show outlook/oauth2-client-secret"
sasl.oauth2.access-token.command = "pass show outlook/oauth2-access-token"
sasl.oauth2.refresh-token.command = "pass show outlook/oauth2-refresh-token"
sasl.oauth2.auth-url = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
sasl.oauth2.token-url = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
sasl.oauth2.pkce = true
sasl.oauth2.scopes = ["https://outlook.office.com/IMAP.AccessAsUser.All", "https://outlook.office.com/SMTP.Send"]
```

---

## iCloud Mail

**Important notes:**

- IMAP login = username only (e.g., `johnappleseed`, NOT `johnappleseed@icloud.com`)
- SMTP login = full email address
- Requires App-Specific Password: https://appleid.apple.com/account/manage
- Store in pass: `pass insert icloud/app-password`

```toml
[accounts.icloud]
email = "yourname@icloud.com"

[accounts.icloud.imap]
server = "imap.mail.me.com:993"
sasl.plain.username = "yourname"  # Username only, no @icloud.com!
sasl.plain.password.command = "pass show icloud/app-password"

[accounts.icloud.smtp]
server = "smtp.mail.me.com:587"
starttls = true
sasl.plain.username = "yourname@icloud.com"  # Full email for SMTP
sasl.plain.password.command = "pass show icloud/app-password"
```

**Note**: This same app-specific password works for iCloud Calendar. Store once, use for both email and calendar skills.

---

## Proton Mail (via Proton Bridge)

**Prerequisites:**

1. Install and run Proton Bridge: https://proton.me/mail/bridge
2. Use the password generated by Proton Bridge (NOT your Proton account password)

```toml
[accounts.proton]
email = "yourname@proton.me"

[accounts.proton.imap]
server = "127.0.0.1:1143"
sasl.plain.username = "yourname@proton.me"
sasl.plain.password.keyring = "proton-bridge-password"

[accounts.proton.smtp]
server = "127.0.0.1:1025"
sasl.plain.username = "yourname@proton.me"
sasl.plain.password.keyring = "proton-bridge-password"
```

Proton Bridge terminates TLS locally, so no `tls`/`starttls` block is needed. If you export the
Bridge certificate and want to enforce it, add `tls.type = "start-tls"` plus a `tls.cert` pointing
at the PEM under the `imap`/`smtp` tables.

---

## Fastmail

**Setup:**

1. Generate App Password: Settings → Password & Security → App Passwords
2. Store in pass: `pass insert fastmail/app-password`

```toml
[accounts.fastmail]
email = "yourname@fastmail.com"

[accounts.fastmail.imap]
server = "imap.fastmail.com:993"
sasl.plain.username = "yourname@fastmail.com"
sasl.plain.password.command = "pass show fastmail/app-password"

[accounts.fastmail.smtp]
server = "smtp.fastmail.com:465"
sasl.plain.username = "yourname@fastmail.com"
sasl.plain.password.command = "pass show fastmail/app-password"
```

**Note**: Use "All" access when creating the app password to enable both email and calendar sync with the same credential.

---

## Yahoo Mail

**Prerequisites:**

- Generate App Password: https://login.yahoo.com/account/security

```toml
[accounts.yahoo]
email = "yourname@yahoo.com"

[accounts.yahoo.imap]
server = "imap.mail.yahoo.com:993"
sasl.plain.username = "yourname@yahoo.com"
sasl.plain.password.keyring = "yahoo-password"

[accounts.yahoo.smtp]
server = "smtp.mail.yahoo.com:465"
sasl.plain.username = "yourname@yahoo.com"
sasl.plain.password.keyring = "yahoo-password"
```

---

## Generic IMAP/SMTP

For other providers, use this template:

```toml
[accounts.custom]
email = "yourname@example.com"

[accounts.custom.imap]
server = "imap.example.com:993"
sasl.plain.username = "yourname@example.com"
sasl.plain.password.keyring = "custom-password"

[accounts.custom.smtp]
server = "smtp.example.com:465"  # or :587 with starttls = true
sasl.plain.username = "yourname@example.com"
sasl.plain.password.keyring = "custom-password"
```

---

## Password Storage Options

### Option 1: Password Manager with pass (Recommended for Jazz)

Use `pass` (Password Store) with consistent naming for reusability across email and calendar skills. For multiple accounts of the same provider, use a hierarchical folder structure (e.g., `google/personal/app-password` and `google/work/app-password`). The `/` character explicitly creates a folder structure in `pass`.

```toml
sasl.plain.password.command = "pass show google/app-password"
```

**Consistent naming convention**:

```bash
# Initialize pass if not already done
pass init your-gpg-key-id

# Store passwords using provider/app-password format
pass insert google/app-password      # Same for Gmail + Google Calendar
pass insert icloud/app-password      # Same for iCloud Mail + iCloud Calendar
pass insert fastmail/app-password    # Same for Fastmail Mail + Fastmail Calendar
pass insert nextcloud/app-password   # Same for email + calendar
pass insert work/app-password        # Work accounts

# Multi-account example (hierarchical)
pass insert google/personal/app-password
pass insert google/work/app-password
pass insert fastmail/account_a/app-password
pass insert fastmail/account_b/app-password
```

**Benefits**:

- Same password works for both email (Himalaya) and calendar (khal/vdirsyncer)
- Encrypted storage with GPG
- Command-line access
- Git-syncable for backup

### Option 2: System Keyring

```toml
sasl.plain.password.keyring = "account-name"
```

The agent stores the secret via `security add-generic-password` (macOS) or the platform keyring.
Keyring storage is Himalaya-specific and won't be automatically shared with calendar tools.

### Option 3: Raw Password (NOT Recommended)

```toml
sasl.plain.password.raw = "your-password-here"
```

⚠️ Only use for testing. Never commit to version control.

---

## Common IMAP/SMTP Ports

| Protocol | Port | Encryption       |
| -------- | ---- | ---------------- |
| IMAP     | 993  | TLS              |
| IMAP     | 143  | STARTTLS or none |
| SMTP     | 465  | TLS              |
| SMTP     | 587  | STARTTLS         |
| SMTP     | 25   | None (legacy)    |
