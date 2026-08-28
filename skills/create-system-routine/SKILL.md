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

## Security

A scheduled routine runs unattended, in the invoking user's context, with no terminal and no chance to answer a prompt.

- Never inline secrets (API keys, tokens, passwords) in the cron line or plist. Load them from a file with restricted permissions (e.g. `chmod 600`) inside the wrapped script, or from the environment.
- Prefer wrapping the real work in a script and calling that script. This keeps `PATH`, environment, and error handling in one auditable place.
- The routines this skill creates are **user-level** and run with the user's privileges. Do not schedule commands that escalate privileges or mutate system state without explicit confirmation.
- Always explain what will change and keep a backup (e.g. `crontab -l > /tmp/crontab.bak`) before any destructive edit.

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

2. **Gather routine parameters from the user (questionnaire if needed)**

   **Do not create the cron entry or plist until you have enough information.** If the user's request is vague (e.g. "schedule something", "run a script daily") or missing any of the items below, guide them through a short questionnaire instead of guessing.

   **You have enough info when you know:**

   - **Command or script** to run (absolute path preferred). If they only have a relative path or "a script", ask for the full path or help them resolve it. Verify the target is executable (see step 3.1 / 4.1).
   - **Schedule**: When should it run?
     - For Linux: cron expression (e.g. `0 8 * * *`)
     - For macOS: time components for `StartCalendarInterval` (e.g. Hour=8, Minute=0)
   - **Behavior if the machine is off/asleep at the scheduled time**: Explain that neither cron nor launchd will run while the machine is off; offer "run at scheduled time and on boot/login" if they want catch-up (see step 3.4 / 4.6).
   - **Output destination**: Where should logs go? Recommend a dedicated log file (e.g. `~/.local/share/jazz-routines/<name>.log`) so failures are diagnosable.

   **How to run the questionnaire:**

   - Ask **one or a few questions at a time**; don't dump a long list.
   - If they said "daily" or "every hour", convert to cron/launchd and confirm.
   - Once you have command/script, schedule, and a log destination (and optionally catch-up behavior), proceed to create the routine.

3. **Linux / cron workflow** (`os=linux`)

   1. **Validate tools and target**:

      Check for `crontab` availability:

      ```bash
      command -v crontab >/dev/null 2>&1
      ```

      If missing, explain that cron is not available and suggest `systemd` timers or another scheduler; this skill does not configure those directly.

      Verify the target script exists and is executable:

      ```bash
      test -x "<COMMAND>" || echo "warn: not executable"
      ```

      If it is a script, confirm it has a valid shebang (`#!/bin/sh`, `#!/usr/bin/env bash`, etc.). If it is merely not `+x`, offer to `chmod +x` it (with confirmation) or wrap it in a shell invocation.

   2. **Prepare the cron entry**:

      Capture both stdout and stderr to a log file so the job is diagnosable:

      ```bash
      "<CRON_SCHEDULE> <COMMAND> >> <LOG_FILE> 2>&1 # created-by-jazz-create-system-routine"
      ```

      Use absolute paths for both the command and any scripts. If environment variables are needed, recommend wrapping logic in a shell script and calling that script from cron.

   3. **Install the cron entry (user crontab)**:

      Safely append the new entry to the user's crontab, keeping a backup first:

      ```bash
      backup=$(mktemp)
      crontab -l 2>/dev/null >"$backup" || true
      tmp_cron=$(mktemp)
      crontab -l 2>/dev/null >"$tmp_cron" || true
      printf '%s\n' "<CRON_LINE>" >>"$tmp_cron"
      crontab "$tmp_cron"
      rm -f "$tmp_cron"
      ```

      - Preserve existing cron entries.
      - Tag the entry with a comment so it can be identified/removed later.

   4. **Verify the install**:

      ```bash
      crontab -l | grep 'created-by-jazz-create-system-routine'
      ```

      Confirm the new line is present before reporting success.

   5. **(Optional) Boot or login catch-up**:

      For "run at 8am or next boot" semantics, use a guard script that only runs once per day after a given time, then call it from **both** a time-based cron (e.g. `0 8 * * *`) and an `@reboot` entry:

      ```bash
      #!/bin/sh
      # <GUARD_SCRIPT> — runs the real job at most once per day after <HOUR>:00.
      marker="$HOME/.cache/jazz-routines/<name>.lastrun"
      now_epoch=$(date +%s)
      today_midnight=$(( now_epoch - (now_epoch % 86400) + <HOUR> * 3600 ))
      last=$(cat "$marker" 2>/dev/null || echo 0)
      last_day=$(( last - (last % 86400) ))
      if [ "$last_day" -lt "$(( today_midnight - last % 86400 ))" ] && [ "$now_epoch" -ge "$today_midnight" ]; then
        <REAL_COMMAND> >> <LOG_FILE> 2>&1
        date +%s > "$marker"
      fi
      ```

      (Adapt the once-per-day check to taste; the principle is a timestamp marker gating execution.)

4. **macOS / launchd workflow** (`os=macos`)

   1. **Validate the target**:

      Confirm the target script exists and is executable:

      ```bash
      test -x "<COMMAND>" || echo "warn: not executable"
      ```

      If it is a script, confirm it has a valid shebang. Offer to `chmod +x` it (with confirmation) or invoke it via a shell in `ProgramArguments`.

   2. **Choose target: LaunchAgent vs LaunchDaemon**:

      - Prefer **LaunchAgent** for user-level routines:
        - Location: `~/Library/LaunchAgents`
        - Runs in the context of the logged-in user.
      - Use LaunchDaemon only for system-wide services (not typical for personal routines).

   3. **Create LaunchAgents directory if needed**:

      Ensure `~/Library/LaunchAgents` exists before writing plist files.

   4. **Define a unique label**:

      Use a reverse-DNS-style label matching the skill name, e.g. `com.jazz.create-system-routine.<name>`.

   5. **Write a plist file**

      Create a plist at:

      ```text
      ~/Library/LaunchAgents/com.jazz.create-system-routine.<name>.plist
      ```

      Example template:

      ```xml
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>com.jazz.create-system-routine.<name></string>

          <key>ProgramArguments</key>
          <array>
            <string>/bin/zsh</string>
            <string>-lc</string>
            <string>/absolute/path/to/script.sh</string>
          </array>

          <key>WorkingDirectory</key>
          <string>/absolute/working/directory</string>

          <key>StandardOutPath</key>
          <string>/absolute/path/to/<name>.out.log</string>

          <key>StandardErrorPath</key>
          <string>/absolute/path/to/<name>.err.log</string>

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
      - `StandardOutPath` / `StandardErrorPath` make failures diagnosable; without them output is discarded.

   6. **Load (or reload) the LaunchAgent**

      Use the modern `bootstrap`/`bootout` verbs (the older `load`/`unload` verbs are deprecated on current macOS). `gui/$UID` targets the current user's session:

      ```bash
      uid=$(id -u)
      launchctl bootout "gui/$uid/com.jazz.create-system-routine.<name>" 2>/dev/null || true
      launchctl bootstrap "gui/$uid" ~/Library/LaunchAgents/com.jazz.create-system-routine.<name>.plist
      launchctl kickstart "gui/$uid/com.jazz.create-system-routine.<name>"
      ```

   7. **Verify the install**:

      ```bash
      launchctl list | grep 'com.jazz.create-system-routine.<name>'
      ```

      Confirm the job appears (the status column will populate after first run).

   8. **Explain off/asleep behavior**

      Clarify that:
      - If the Mac is off or fully asleep at the scheduled time, launchd will not run the job at that moment.
      - For "run at 8am or next login" behavior, combine `StartCalendarInterval` with `RunAtLoad` and implement a small guard in the script that only runs once per day after a certain time (see step 3.5 for a guard pattern).

5. **Windows / unsupported workflow** (`os=windows` or `os=unknown`)

   - Do **not** attempt to create or modify tasks.
   - Respond with clear guidance:
     - Explain that this skill does not manage Windows Task Scheduler.
     - Suggest the user configure a task manually in Task Scheduler or use another tool.

6. **Removal / update of routines**

   When the user wants to remove or update routines created by this skill:

   - **Linux (cron)**:
     - Back up first: `crontab -l > /tmp/crontab.bak`.
     - Read the current crontab: `crontab -l`.
     - Filter out or edit lines with `# created-by-jazz-create-system-routine`.
     - Write back the modified crontab.

   - **macOS (launchd)**:
     - Unload the LaunchAgent via `launchctl bootout "gui/$uid/com.jazz.create-system-routine.<name>"`.
     - Edit or remove the corresponding plist file under `~/Library/LaunchAgents`.

   Always explain what will be changed and keep backups where practical before destructive edits.
