# Email Provider Configuration

Detailed setup instructions for common email providers with Himalaya.

Config file location: `~/.config/himalaya/config.toml`

---

## Gmail

### Option 1: App Password with pass (Recommended)

**Prerequisites:**
1. Enable IMAP in Gmail settings
2. Enable 2-Step Verification
3. Create App Password: https://myaccount.google.com/apppasswords
4. Store in pass: `pass insert google/app-password`

```toml
[accounts.gmail]
email = "yourname@gmail.com"

folder.aliases.inbox = "INBOX"
folder.aliases.sent = "[Gmail]/Sent Mail"
folder.aliases.drafts = "[Gmail]/Drafts"
folder.aliases.trash = "[Gmail]/Trash"

backend.type = "imap"
backend.host = "imap.gmail.com"
backend.port = 993
backend.login = "yourname@gmail.com"
backend.auth.type = "password"
backend.auth.cmd = "pass show google/app-password"

message.send.backend.type = "smtp"
message.send.backend.host = "smtp.gmail.com"
message.send.backend.port = 465
message.send.backend.login = "yourname@gmail.com"
message.send.backend.auth.type = "password"
message.send.backend.auth.cmd = "pass show google/app-password"
```

**Note**: This same app-specific password works for Google Calendar. Store once, use for both email and calendar skills.

### Option 1b: App Password with keyring

```toml
backend.auth.keyring = "gmail-password"
message.send.backend.auth.keyring = "gmail-password"
```

Then run:
```bash
himalaya account configure gmail
# Paste your App Password when prompted
```

### Option 2: OAuth 2.0 (More Secure)

Requires creating OAuth credentials in Google Cloud Console.

```toml
[accounts.gmail]
email = "yourname@gmail.com"

folder.aliases.inbox = "INBOX"
folder.aliases.sent = "[Gmail]/Sent Mail"
folder.aliases.drafts = "[Gmail]/Drafts"
folder.aliases.trash = "[Gmail]/Trash"

backend.type = "imap"
backend.host = "imap.gmail.com"
backend.port = 993
backend.login = "yourname@gmail.com"
backend.auth.type = "oauth2"
backend.auth.method = "xoauth2"
backend.auth.client-id = "YOUR_CLIENT_ID"
backend.auth.client-secret.keyring = "gmail-oauth2-client-secret"
backend.auth.access-token.keyring = "gmail-oauth2-access-token"
backend.auth.refresh-token.keyring = "gmail-oauth2-refresh-token"
backend.auth.auth-url = "https://accounts.google.com/o/oauth2/v2/auth"
backend.auth.token-url = "https://www.googleapis.com/oauth2/v3/token"
backend.auth.pkce = true
backend.auth.scope = "https://mail.google.com/"

message.send.backend.type = "smtp"
message.send.backend.host = "smtp.gmail.com"
message.send.backend.port = 465
message.send.backend.login = "yourname@gmail.com"
message.send.backend.auth.type = "oauth2"
message.send.backend.auth.method = "xoauth2"
message.send.backend.auth.client-id = "YOUR_CLIENT_ID"
message.send.backend.auth.client-secret.keyring = "gmail-oauth2-client-secret"
message.send.backend.auth.access-token.keyring = "gmail-oauth2-access-token"
message.send.backend.auth.refresh-token.keyring = "gmail-oauth2-refresh-token"
message.send.backend.auth.auth-url = "https://accounts.google.com/o/oauth2/v2/auth"
message.send.backend.auth.token-url = "https://www.googleapis.com/oauth2/v3/token"
message.send.backend.auth.pkce = true
message.send.backend.auth.scope = "https://mail.google.com/"
```

---

## Outlook / Microsoft 365

### Option 1: Password with pass

Store in pass: `pass insert outlook/app-password`

```toml
[accounts.outlook]
email = "yourname@outlook.com"

backend.type = "imap"
backend.host = "outlook.office365.com"
backend.port = 993
backend.login = "yourname@outlook.com"
backend.auth.type = "password"
backend.auth.cmd = "pass show outlook/app-password"

message.send.backend.type = "smtp"
message.send.backend.host = "smtp-mail.outlook.com"
message.send.backend.port = 587
message.send.backend.encryption.type = "start-tls"
message.send.backend.login = "yourname@outlook.com"
message.send.backend.auth.type = "password"
message.send.backend.auth.cmd = "pass show outlook/app-password"
```

### Option 2: OAuth 2.0

```toml
[accounts.outlook]
email = "yourname@outlook.com"

backend.type = "imap"
backend.host = "outlook.office365.com"
backend.port = 993
backend.login = "yourname@outlook.com"
backend.auth.type = "oauth2"
backend.auth.client-id = "YOUR_CLIENT_ID"
backend.auth.client-secret.keyring = "outlook-oauth2-client-secret"
backend.auth.access-token.keyring = "outlook-oauth2-access-token"
backend.auth.refresh-token.keyring = "outlook-oauth2-refresh-token"
backend.auth.auth-url = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
backend.auth.token-url = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
backend.auth.pkce = true
backend.auth.scopes = ["https://outlook.office.com/IMAP.AccessAsUser.All", "https://outlook.office.com/SMTP.Send"]

message.send.backend.type = "smtp"
message.send.backend.host = "smtp.mail.outlook.com"
message.send.backend.port = 587
message.send.backend.starttls = true
message.send.backend.login = "yourname@outlook.com"
message.send.backend.auth.type = "oauth2"
message.send.backend.auth.client-id = "YOUR_CLIENT_ID"
message.send.backend.auth.client-secret.keyring = "outlook-oauth2-client-secret"
message.send.backend.auth.access-token.keyring = "outlook-oauth2-access-token"
message.send.backend.auth.refresh-token.keyring = "outlook-oauth2-refresh-token"
message.send.backend.auth.auth-url = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
message.send.backend.auth.token-url = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
message.send.backend.auth.pkce = true
message.send.backend.auth.scopes = ["https://outlook.office.com/IMAP.AccessAsUser.All", "https://outlook.office.com/SMTP.Send"]
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

backend.type = "imap"
backend.host = "imap.mail.me.com"
backend.port = 993
backend.login = "yourname"  # Username only, no @icloud.com!
backend.auth.type = "password"
backend.auth.cmd = "pass show icloud/app-password"

message.send.backend.type = "smtp"
message.send.backend.host = "smtp.mail.me.com"
message.send.backend.port = 587
message.send.backend.encryption.type = "start-tls"
message.send.backend.login = "yourname@icloud.com"  # Full email for SMTP
message.send.backend.auth.type = "password"
message.send.backend.auth.cmd = "pass show icloud/app-password"
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

backend.type = "imap"
backend.host = "127.0.0.1"
backend.port = 1143
backend.encryption.type = "none"  # Bridge handles encryption
backend.login = "yourname@proton.me"
backend.auth.type = "password"
backend.auth.keyring = "proton-bridge-password"

message.send.backend.type = "smtp"
message.send.backend.host = "127.0.0.1"
message.send.backend.port = 1025
message.send.backend.encryption.type = "none"
message.send.backend.login = "yourname@proton.me"
message.send.backend.auth.type = "password"
message.send.backend.auth.keyring = "proton-bridge-password"
```

### With TLS (Alternative)

Export certificate from Proton Bridge, then:

```toml
backend.encryption.type = "start-tls"
backend.encryption.cert = "/path/to/proton-bridge-cert.pem"

message.send.backend.encryption.type = "start-tls"
message.send.backend.encryption.cert = "/path/to/proton-bridge-cert.pem"
```

---

## Fastmail

**Setup:**
1. Generate App Password: Settings → Password & Security → App Passwords
2. Store in pass: `pass insert fastmail/app-password`

```toml
[accounts.fastmail]
email = "yourname@fastmail.com"

backend.type = "imap"
backend.host = "imap.fastmail.com"
backend.port = 993
backend.login = "yourname@fastmail.com"
backend.auth.type = "password"
backend.auth.cmd = "pass show fastmail/app-password"

message.send.backend.type = "smtp"
message.send.backend.host = "smtp.fastmail.com"
message.send.backend.port = 465
message.send.backend.login = "yourname@fastmail.com"
message.send.backend.auth.type = "password"
message.send.backend.auth.cmd = "pass show fastmail/app-password"
```

**Note**: Use "All" access when creating the app password to enable both email and calendar sync with the same credential.

---

## Yahoo Mail

**Prerequisites:**
- Generate App Password: https://login.yahoo.com/account/security

```toml
[accounts.yahoo]
email = "yourname@yahoo.com"

backend.type = "imap"
backend.host = "imap.mail.yahoo.com"
backend.port = 993
backend.login = "yourname@yahoo.com"
backend.auth.type = "password"
backend.auth.keyring = "yahoo-password"

message.send.backend.type = "smtp"
message.send.backend.host = "smtp.mail.yahoo.com"
message.send.backend.port = 465
message.send.backend.login = "yourname@yahoo.com"
message.send.backend.auth.type = "password"
message.send.backend.auth.keyring = "yahoo-password"
```

---

## Generic IMAP/SMTP

For other providers, use this template:

```toml
[accounts.custom]
email = "yourname@example.com"

backend.type = "imap"
backend.host = "imap.example.com"
backend.port = 993
backend.login = "yourname@example.com"
backend.auth.type = "password"
backend.auth.keyring = "custom-password"

message.send.backend.type = "smtp"
message.send.backend.host = "smtp.example.com"
message.send.backend.port = 465  # or 587 with start-tls
message.send.backend.login = "yourname@example.com"
message.send.backend.auth.type = "password"
message.send.backend.auth.keyring = "custom-password"
```

---

## Password Storage Options

### Option 1: Password Manager with pass (Recommended for Jazz)

Use `pass` (Password Store) with consistent naming for reusability across email and calendar skills:

```toml
backend.auth.cmd = "pass show google/app-password"
message.send.backend.auth.cmd = "pass show google/app-password"
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
```

**Benefits**:
- Same password works for both email (Himalaya) and calendar (khal/vdirsyncer)
- Encrypted storage with GPG
- Command-line access
- Git-syncable for backup

### Option 2: System Keyring

```toml
backend.auth.keyring = "account-name"
```

Run `himalaya account configure <name>` to store password securely.

**Note**: Keyring storage is Himalaya-specific and won't be automatically shared with calendar tools.

### Option 3: Raw Password (NOT Recommended)

```toml
backend.auth.raw = "your-password-here"
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
