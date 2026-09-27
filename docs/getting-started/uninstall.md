---
description: "Remove Jazz completely: scheduled jobs, the daemon service, chat bots, keyring entries, the ~/.jazz data directory, and the binary, in the order that leaves nothing firing."
---

# Uninstalling Jazz

There is no `jazz uninstall` command. Remove things in this order, so nothing keeps firing a
binary that is gone: schedules first, then services, then secrets, then data, then the
binary.

If you used `JAZZ_HOME` or `--data-dir` for more than one home, repeat the steps that mention
`~/.jazz` for each home.

## 1. Scheduled workflows

List what is scheduled, then remove each one:

```bash
jazz workflow scheduled
jazz workflow unschedule <name>
```

On macOS each schedule is a launchd job in `~/Library/LaunchAgents/com.jazz.workflow.*.plist`;
on Linux it is a crontab line below a `# Jazz schedule:` comment. Check that none are left:

```bash
ls ~/Library/LaunchAgents/com.jazz.* 2>/dev/null   # macOS
crontab -l | grep -A1 '# Jazz'                     # Linux
```

## 2. Reminders and wake-ups

Reminders and wake-ups an agent set are one-shot jobs. Ask the agent to cancel them, or remove
them by hand:

```bash
# macOS
for plist in ~/Library/LaunchAgents/com.jazz.reminder.*.plist ~/Library/LaunchAgents/com.jazz.trigger.*.plist; do
  [ -e "$plist" ] || continue
  launchctl unload "$plist"
  rm "$plist"
done

# Linux: they are `at` jobs
atq
atrm <job-number>
```

## 3. The daemon

Stop a daemon you started yourself, and remove the system service if you installed one:

```bash
jazz daemon stop
sudo jazz daemon uninstall
```

`jazz daemon uninstall` removes `/Library/LaunchDaemons/com.jazz.daemon.plist` on macOS or
`/etc/systemd/system/jazz-daemon.service` on Linux, and the `/etc/jazz/daemon.env` file
beside it.

## 4. Chat bots

- **iMessage on your Mac:** run `jazz imessage stop`, then remove
  `~/Library/LaunchAgents/com.github.lvndry.jazz.imessage.plist` and the bridge's data in
  `~/.jazz-imessage`.
- **iMessage through Photon:** remove `~/.jazz-photon`.
- **WhatsApp:** unlink the device in WhatsApp (**Settings → Linked devices**), then remove
  `~/.jazz-whatsapp`, which holds the link keys.
- **Telegram and Discord:** stop the containers (`docker compose down` in the bot's
  directory), remove the `auto-update.sh` cron line if you added one, and delete the data
  volume. See [Reaching your agent from a chat app](../guides/deploy-a-chat-agent.md).

## 5. Keyring entries

API keys, tokens and sign-ins live in the OS keyring, one entry per setting. The entry's
account is the setting (`llm.openai.api_key`, `daemon.token`, `chatgpt.oauth.credential`, and
so on) and its service is `jazz`, or a name starting with `jazz.` for a home that keeps its
own entries.

```bash
# macOS: list the entries, then delete each one by its service ("svce") and account ("acct")
security dump-keychain | grep -B4 -A4 '"svce"<blob>="jazz'
security delete-generic-password -s <service> -a <account>

# Linux: list the entries for one account name, then clear each
secret-tool search --all account llm.openai.api_key
secret-tool clear service <service> account <account>
```

On a host without a keyring, secrets are in `~/.jazz/secrets.json`, which the next step
removes.

## 6. Data and configuration

Everything else Jazz keeps (config, agents, conversations, memory, logs, caches and the
unpacked runtime) is in one directory:

```bash
rm -rf ~/.jazz
```

[Runtime data](../runtime-data/index.md) lists what is in it, if you want to keep a copy of
your agents or conversations first. A project's own `./.jazz/config.json` is only removed if
you delete it.

Two more locations are shared with other tools, so check them before deleting:

- `~/.agents/mcp.json` holds the MCP servers `jazz mcp add` wrote. Remove Jazz's entries with
  `jazz mcp remove <name>`, or delete the file if nothing else uses it.
- `~/.agents/skills/` holds skills other agents may also read. Jazz only reads it.

## 7. The binary

Remove it the way you installed it:

```bash
rm ~/.local/bin/jazz        # install script (or wherever JAZZ_INSTALL_DIR pointed)
npm rm -g jazz-ai           # npm
bun rm -g jazz-ai           # bun
pnpm rm -g jazz-ai          # pnpm
yarn global remove jazz-ai  # yarn
```

`which -a jazz` should then print nothing.
