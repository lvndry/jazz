# CalDAV Provider Configuration Reference

Detailed configuration examples for popular CalDAV providers.

---

## Google Calendar

### Requirements
- App-specific password or OAuth 2.0 setup
- Calendar must be visible in Google Calendar settings

### vdirsyncer Configuration

```ini
[pair google_calendar]
a = "google_local"
b = "google_remote"
collections = ["from a", "from b"]
conflict_resolution = "b wins"

[storage google_local]
type = "filesystem"
path = "~/.local/share/khal/calendars/"
fileext = ".ics"

[storage google_remote]
type = "caldav"
url = "https://apidata.googleusercontent.com/caldav/v2/your.email@gmail.com/"
username = "your.email@gmail.com"
password.fetch = ["command", "pass", "google/app-password"]  # Same password used for email
```

### OAuth 2.0 Setup (Advanced)

```ini
[storage google_remote]
type = "google_calendar"
token_file = "~/.config/vdirsyncer/google_token"
client_id = "your_client_id"
client_secret = "your_client_secret"
```

### Getting App-Specific Password
1. Go to Google Account settings
2. Navigate to Security → 2-Step Verification
3. Scroll to "App passwords"
4. Generate new password (select "Mail" or "Calendar" - same password works for both)
5. Store in password manager: `pass insert google/app-password`

**Note**: This same app-specific password works for both Gmail (email) and Google Calendar. Store it once and reuse for both email and calendar skills.

---

## Nextcloud

### Requirements
- Nextcloud instance with Calendar app enabled
- Username and password

### vdirsyncer Configuration

```ini
[pair nextcloud_calendar]
a = "nextcloud_local"
b = "nextcloud_remote"
collections = ["from a", "from b"]

[storage nextcloud_local]
type = "filesystem"
path = "~/.local/share/khal/calendars/"
fileext = ".ics"

[storage nextcloud_remote]
type = "caldav"
url = "https://nextcloud.example.com/remote.php/dav/"
username = "your_username"
password.fetch = ["command", "pass", "nextcloud/app-password"]
```

### Alternative: Using Bearer Token

```ini
[storage nextcloud_remote]
type = "caldav"
url = "https://nextcloud.example.com/remote.php/dav/"
username = "your_username"
password = "app-token-here"
```

### Getting Nextcloud App Token
1. Settings → Security → Devices & sessions
2. Create new app password
3. Name it "vdirsyncer"
4. Use generated token as password

---

## iCloud

### Requirements
- Apple ID with iCloud enabled
- App-specific password (required if 2FA enabled)
- Server URL: `https://caldav.icloud.com/`

### vdirsyncer Configuration

```ini
[pair icloud_calendar]
a = "icloud_local"
b = "icloud_remote"
collections = ["from a", "from b"]

[storage icloud_local]
type = "filesystem"
path = "~/.local/share/khal/calendars/"
fileext = ".ics"

[storage icloud_remote]
type = "caldav"
url = "https://caldav.icloud.com/"
username = "your_apple_id@icloud.com"
password.fetch = ["command", "pass", "icloud/app-password"]  # Same password used for email
```

### Getting iCloud App-Specific Password
1. Go to appleid.apple.com
2. Sign in
3. Navigate to "Security" section
4. Under "App-Specific Passwords", click "Generate Password"
5. Label it "Jazz" or "email and calendar"
6. Store password: `pass insert icloud/app-password`

**Note**: This same app-specific password works for both iCloud Mail (email) and iCloud Calendar. Store it once and reuse for both email and calendar skills.

---

## Fastmail

### Requirements
- Fastmail account
- App password recommended

### vdirsyncer Configuration

```ini
[pair fastmail_calendar]
a = "fastmail_local"
b = "fastmail_remote"
collections = ["from a", "from b"]

[storage fastmail_local]
type = "filesystem"
path = "~/.local/share/khal/calendars/"
fileext = ".ics"

[storage fastmail_remote]
type = "caldav"
url = "https://caldav.fastmail.com/dav/calendars/user/your.email@fastmail.com/"
username = "your.email@fastmail.com"
password.fetch = ["command", "pass", "fastmail/app-password"]
```

### Getting Fastmail App Password
1. Settings → Password & Security
2. Scroll to "App Passwords"
3. Click "New App Password"
4. Name: "Jazz", Access: "Mail (IMAP/SMTP)" or "Calendars (CalDAV)" or "All"
5. Store: `pass insert fastmail/app-password`

**Note**: Fastmail app passwords can have different access levels. If you want to use the same password for both email and calendar, select "All" access.

---

## Radicale (Self-Hosted)

### Requirements
- Radicale server running
- Network access to server

### vdirsyncer Configuration

```ini
[pair radicale_calendar]
a = "radicale_local"
b = "radicale_remote"
collections = ["from a", "from b"]

[storage radicale_local]
type = "filesystem"
path = "~/.local/share/khal/calendars/"
fileext = ".ics"

[storage radicale_remote]
type = "caldav"
url = "http://localhost:5232/"
username = "your_username"
password.fetch = ["command", "pass", "radicale/app-password"]
```

### HTTPS with Self-Signed Certificate

```ini
[storage radicale_remote]
type = "caldav"
url = "https://radicale.example.com:5233/"
username = "your_username"
password.fetch = ["command", "pass", "radicale/app-password"]
verify = false  # Only if using self-signed cert
```

---

## Baikal (Self-Hosted)

### Requirements
- Baikal server instance
- CalDAV access enabled

### vdirsyncer Configuration

```ini
[pair baikal_calendar]
a = "baikal_local"
b = "baikal_remote"
collections = ["from a", "from b"]

[storage baikal_local]
type = "filesystem"
path = "~/.local/share/khal/calendars/"
fileext = ".ics"

[storage baikal_remote]
type = "caldav"
url = "https://baikal.example.com/dav.php/"
username = "your_username"
password.fetch = ["command", "pass", "baikal/app-password"]
```

---

## SOGo

### Requirements
- SOGo groupware server
- User credentials

### vdirsyncer Configuration

```ini
[pair sogo_calendar]
a = "sogo_local"
b = "sogo_remote"
collections = ["from a", "from b"]

[storage sogo_local]
type = "filesystem"
path = "~/.local/share/khal/calendars/"
fileext = ".ics"

[storage sogo_remote]
type = "caldav"
url = "https://sogo.example.com/SOGo/dav/"
username = "your_username"
password.fetch = ["command", "pass", "sogo/app-password"]
```

---

## Synology Calendar

### Requirements
- Synology NAS with Calendar package
- User account with calendar access

### vdirsyncer Configuration

```ini
[pair synology_calendar]
a = "synology_local"
b = "synology_remote"
collections = ["from a", "from b"]

[storage synology_local]
type = "filesystem"
path = "~/.local/share/khal/calendars/"
fileext = ".ics"

[storage synology_remote]
type = "caldav"
url = "https://synology.example.com:5001/caldav/"
username = "your_username"
password.fetch = ["command", "pass", "synology/app-password"]
verify = true
```

---

## Password Management

### Using pass (Password Store) - Recommended

Store passwords securely using a consistent naming convention:

```bash
# Initialize pass if not already done
pass init your-gpg-key-id

# Store passwords (use app-password for consistency with email skill)
pass insert google/app-password
pass insert nextcloud/app-password
pass insert icloud/app-password
pass insert fastmail/app-password

# Retrieve passwords
pass show google/app-password
```

**Convention**: Use `provider/app-password` format to keep credentials organized and reusable across both email and calendar skills.

### Using Environment Variables

```ini
[storage remote]
type = "caldav"
url = "https://caldav.example.com/"
username = "user"
password = "${CALDAV_PASSWORD}"
```

Then set in shell:
```bash
export CALDAV_PASSWORD="your_password"
```

### Using Keyring

```bash
# Install keyring
pip install keyring

# Store password
keyring set caldav username
```

In vdirsyncer config:
```ini
password.fetch = ["command", "keyring", "get", "caldav", "username"]
```

---

## Multi-Calendar Setup

### Example: Work + Personal + Shared

```ini
[general]
status_path = "~/.local/share/vdirsyncer/status/"

# Work Calendar
[pair work_calendar]
a = "work_local"
b = "work_remote"
collections = ["from a", "from b"]

[storage work_local]
type = "filesystem"
path = "~/.local/share/khal/calendars/work"
fileext = ".ics"

[storage work_remote]
type = "caldav"
url = "https://caldav.work.com/"
username = "work.email@company.com"
password.fetch = ["command", "pass", "work/app-password"]

# Personal Calendar
[pair personal_calendar]
a = "personal_local"
b = "personal_remote"
collections = ["from a", "from b"]

[storage personal_local]
type = "filesystem"
path = "~/.local/share/khal/calendars/personal"
fileext = ".ics"

[storage personal_remote]
type = "caldav"
url = "https://caldav.fastmail.com/dav/calendars/user/personal@fastmail.com/"
username = "personal@fastmail.com"
password.fetch = ["command", "pass", "fastmail/app-password"]  # Same password used for email

# Shared Team Calendar (read-only)
[pair team_calendar]
a = "team_local"
b = "team_remote"
collections = ["from b"]  # Only sync from remote

[storage team_local]
type = "filesystem"
path = "~/.local/share/khal/calendars/team"
fileext = ".ics"

[storage team_remote]
type = "caldav"
url = "https://caldav.work.com/shared/team/"
username = "work.email@company.com"
password.fetch = ["command", "pass", "work/app-password"]
```

Corresponding khal config:

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

[[team]]
path = ~/.local/share/khal/calendars/team
color = dark green
readonly = true
priority = 15
```

---

## Troubleshooting by Provider

### Google Calendar Issues

**Problem**: "401 Unauthorized" errors
**Solution**: 
- Regenerate app-specific password
- Verify 2FA is enabled
- Check URL includes your email: `https://apidata.googleusercontent.com/caldav/v2/your@gmail.com/`

**Problem**: Missing calendars
**Solution**: Ensure calendars are not hidden in Google Calendar settings

### iCloud Issues

**Problem**: Authentication fails
**Solution**:
- Must use app-specific password (not main password)
- Username is full email address
- May need to wait 5-10 minutes after generating app password

### Nextcloud Issues

**Problem**: "404 Not Found"
**Solution**:
- Verify Calendar app is installed and enabled
- Check URL includes `/remote.php/dav/`
- Try discovering collections: `vdirsyncer discover`

### Self-Hosted Certificate Issues

**Problem**: SSL certificate verification fails
**Solution**:
```ini
[storage remote]
verify = false  # Use with caution
# OR
verify = "/path/to/custom/ca-bundle.crt"
```

---

## Testing Configuration

Before running full sync, test connection:

```bash
# Test discovery
vdirsyncer discover pair_name

# Verbose sync to see errors
vdirsyncer sync --verbosity DEBUG

# Sync specific pair only
vdirsyncer sync work_calendar
```

---

## Performance Optimization

### Selective Calendar Sync

Only sync specific calendars:

```ini
[pair google_calendar]
a = "google_local"
b = "google_remote"
collections = [["personal", "personal", "personal"], ["work", "work", "work"]]
```

### Partial Sync (Recent Events Only)

Reduce sync load by limiting date range:

```ini
[storage google_remote]
type = "caldav"
url = "https://apidata.googleusercontent.com/caldav/v2/user@gmail.com/"
username = "user@gmail.com"
password.fetch = ["command", "pass", "google/password"]
start_date = "datetime.now() - timedelta(days=30)"
end_date = "datetime.now() + timedelta(days=365)"
```
