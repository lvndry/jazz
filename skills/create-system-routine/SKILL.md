---
name: create-system-routine
description: Create time-based system routines (cron/launchd) for scripts or commands. Use this for OS-level scheduling, NOT for Jazz Workflows.
---

# Create System Routine

## When to use this skill

Use this skill when the user wants to create or manage time-based routines (scheduled tasks) at the **OS level** (e.g., running a shell script, a binary, or a specific command).

- **Linux** → use `cron` (`crontab -e`, system/user crontabs)
- **macOS** → use `launchd` (LaunchAgents / LaunchDaemons with plist files)
- **Windows** → this skill should **not** create routines; instead, explain that Windows Task Scheduler must be configured manually.

## Workflow

1. **Detect the operating system**

   Use standard OS detection via shell commands:

   ```bash
   uname_s=$(uname -s 2>/dev/null || echo unknown)
   case "$uname_s" in
     Linux)   os=linux ;;
     Darwin)  os=macos ;;
     MINGW*|MSYS*|CYGWIN*|Windows_NT) os=windows ;;
     *)       os=unknown ;;
   esac
   ```

   - If `os=linux` → follow the **Linux / cron** workflow.
   - If `os=macos` → follow the **macOS / launchd** workflow.
   - If `os=windows` or `os=unknown` → explain that this skill does not create routines on this OS and suggest Windows Task Scheduler or another platform-specific mechanism.

2. **Gather routine parameters from the user**

   Ask (or infer from the request):

   - **Command or script** to run (absolute path preferred)
   - **Schedule**:
     - For Linux: cron expression (e.g. `0 8 * * *`)
     - For macOS: time components for `StartCalendarInterval` (e.g. Hour=8, Minute=0)
   - **Behavior if the machine is off/asleep at the scheduled time**:
     - Explain that neither cron nor launchd will run while the machine is off.
     - Offer a pattern where the routine runs at the scheduled time *and* on boot/login with internal "run once per day" logic, if needed.

3. **Linux / cron workflow** (`os=linux`)

   1. **Validate tools**:

      Check for `crontab` availability:

      ```bash
      command -v crontab >/dev/null 2>&1
      ```

      If missing, explain that cron is not available and suggest `systemd` timers or another scheduler; this skill does not configure those directly.

   2. **Prepare the cron entry**:

      Build a cron line like:

      ```bash
      "<CRON_SCHEDULE> <COMMAND> # created-by-jazz-create-routines"
      ```

      Use absolute paths for both the command and any scripts. If environment variables are needed, recommend wrapping logic in a shell script and calling that script from cron.

   3. **Install the cron entry (user crontab)**:

      Safely append the new entry to the user's crontab:

      ```bash
      tmp_cron=$(mktemp)
      crontab -l 2>/dev/null >"$tmp_cron" || true
      printf '%s\n' "<CRON_LINE>" >>"$tmp_cron"
      crontab "$tmp_cron"
      rm -f "$tmp_cron"
      ```

      - Preserve existing cron entries.
      - Tag the entry with a comment so it can be identified/removed later.

   4. **(Optional) Boot or login catch-up**:

      For "run at 8am or next boot" semantics, instruct the user to:

      - Create a small script that records a last-run timestamp and only runs once per day after a given time.
      - Add **both** a time-based cron (e.g. `0 8 * * *`) and an `@reboot` cron entry that call the same script.

4. **macOS / launchd workflow** (`os=macos`)

   1. **Choose target: LaunchAgent vs LaunchDaemon**:

      - Prefer **LaunchAgent** for user-level routines:
        - Location: `~/Library/LaunchAgents`
        - Runs in the context of the logged-in user.
      - Use LaunchDaemon only for system-wide services (not typical for personal routines).

   2. **Create LaunchAgents directory if needed**:

      Ensure `~/Library/LaunchAgents` exists before writing plist files.

   3. **Define a unique label**:

      Use a reverse-DNS-style label, e.g. `com.jazz.create-routines.<name>`.

   4. **Write a plist file**

      Create a plist at:

      ```text
      ~/Library/LaunchAgents/com.jazz.create-routines.<name>.plist
      ```

      Example template:

      ```xml
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>com.jazz.create-routines.<name></string>

          <key>ProgramArguments</key>
          <array>
            <string>/bin/zsh</string>
            <string>-lc</string>
            <string>/absolute/path/to/script.sh</string>
          </array>

          <key>StartCalendarInterval</key>
          <dict>
            <key>Hour</key>
            <integer>8</integer>
            <key>Minute</key>
            <integer>0</integer>
          </dict>

          <!-- Optional: run when the agent is loaded (e.g. on login) -->
          <key>RunAtLoad</key>
          <true/>
        </dict>
      </plist>
      ```

      Notes:
      - Use absolute paths.
      - If you need environment variables or PATH modifications, do them inside the script.

   5. **Load (or reload) the LaunchAgent**

      ```bash
      launchctl unload ~/Library/LaunchAgents/com.jazz.create-routines.<name>.plist 2>/dev/null || true
      launchctl load ~/Library/LaunchAgents/com.jazz.create-routines.<name>.plist
      ```

   6. **Explain off/asleep behavior**

      Clarify that:
      - If the Mac is off or fully asleep at the scheduled time, launchd will not run the job at that moment.
      - For "run at 8am or next login" behavior, combine `StartCalendarInterval` with `RunAtLoad` and implement a small guard in the script that only runs once per day after a certain time.

5. **Windows / unsupported workflow** (`os=windows` or `os=unknown`)

   - Do **not** attempt to create or modify tasks.
   - Respond with clear guidance:
     - Explain that this skill does not manage Windows Task Scheduler.
     - Suggest the user configure a task manually in Task Scheduler or use another tool.

6. **Removal / update of routines**

   When the user wants to remove or update routines created by this skill:

   - **Linux (cron)**:
     - Read the current crontab: `crontab -l`.
     - Filter out or edit lines with `# created-by-jazz-create-routines`.
     - Write back the modified crontab.

   - **macOS (launchd)**:
     - Unload the LaunchAgent via `launchctl unload`.
     - Edit or remove the corresponding plist file under `~/Library/LaunchAgents`.

   Always explain what will be changed and keep backups where practical (e.g. copy old crontab to a temp file) before destructive edits.
