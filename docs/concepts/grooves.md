# Grooves - Automated Agent Tasks

Grooves let you automate recurring tasks by scheduling agents to run at specific times. Think of them as "cron jobs for AI agents" - scheduled automation that can read your emails, research topics, manage your calendar, and more.

## Quick Start

**💡 Tip**: Use the `create-groove` skill to generate grooves interactively. Just ask your agent: _"Create a groove to clean my email every hour"_ and it will guide you through the process.

### 1. Create a Groove

Create a `GROOVE.md` file in one of these locations:

- **Local** (project-specific): `./grooves/<name>/GROOVE.md`
- **Global** (user-wide): `~/.jazz/grooves/<name>/GROOVE.md`
- **Built-in** (shipped with Jazz): `<jazz-install>/grooves/<name>/GROOVE.md`

### 2. Define the Groove

```markdown
---
name: email-cleanup
description: Clean up newsletters and promotional emails
schedule: "0 * * * *"
autoApprove: low-risk
agent: my-agent
skills:
  - email
---

# Email Cleanup

Review my inbox from the last hour and archive low-value emails.

[Your detailed instructions here...]
```

### 3. Schedule It

```bash
# List available grooves
jazz groove list

# Schedule the groove
jazz groove schedule email-cleanup

# View scheduled grooves
jazz groove scheduled

# Check run history
jazz groove history email-cleanup
```

## Groove File Format

### Frontmatter Fields

| Field              | Required | Description                                       | Example                                               |
| ------------------ | -------- | ------------------------------------------------- | ----------------------------------------------------- |
| `name`             | ✓        | Unique groove identifier                          | `email-cleanup`                                       |
| `description`      | ✓        | Human-readable summary                            | `Clean up old emails`                                 |
| `schedule`         |          | Cron expression for scheduling                    | `0 8 * * *` (daily at 8 AM)                           |
| `agent`            |          | Agent ID/name to use (defaults to user selection) | `research-bot`                                        |
| `autoApprove`      |          | Auto-approval policy for unattended runs          | `true`, `false`, `read-only`, `low-risk`, `high-risk` |
| `skills`           |          | Skills to load for this groove                    | `["email", "calendar"]`                               |
| `catchUpOnStartup` |          | Run missed grooves on startup                     | `true`                                                |
| `maxCatchUpAge`    |          | Max age (seconds) for catch-up runs               | `43200` (12 hours)                                    |

### Cron Schedule Format

Standard 5-field cron format: `minute hour day-of-month month day-of-week`

| Schedule       | Description                          |
| -------------- | ------------------------------------ |
| `0 * * * *`    | Every hour at minute 0               |
| `0 8 * * *`    | Daily at 8:00 AM                     |
| `*/15 * * * *` | Every 15 minutes                     |
| `0 9 * * 1`    | Every Monday at 9:00 AM              |
| `0 0 1 * *`    | First day of every month at midnight |

### Auto-Approve Policies

Auto-approve policies control which tools can execute without user confirmation during scheduled runs:

| Policy             | Behavior                                                               | Use Case                   |
| ------------------ | ---------------------------------------------------------------------- | -------------------------- |
| `false` or omitted | Always prompt for approval                                             | Interactive workflows      |
| `read-only`        | Auto-approve read-only tools (web search, list emails, read files)     | Research, monitoring       |
| `low-risk`         | Auto-approve read-only + low-risk tools (archive email, create events) | Email management, calendar |
| `high-risk`        | Auto-approve all tools including high-risk (delete, send, execute)     | Fully trusted automation   |
| `true`             | Same as `high-risk`                                                    | Fully trusted automation   |

**Safety Note**: Tools are categorized by risk level:

- **Read-only**: `web_search`, `read_file`, `list_emails`, `get_calendar`
- **Low-risk**: `archive_email`, `create_calendar_event`, `label_email`
- **High-risk**: `delete_file`, `send_email`, `execute_command`, `git_push`

### Content (The Prompt)

The content below the frontmatter is the prompt that will be sent to the agent. Write it as if you're giving instructions to a human assistant:

- Be specific about what to do
- Include safety guidelines ("when in doubt, don't do anything")
- Specify output format and location
- Reference skills when applicable

## CLI Commands

### List Grooves

```bash
# List all available grooves
jazz groove list

# Show detailed information about a groove
jazz groove show tech-digest
```

### Run Grooves

```bash
# Run a groove once (manually)
jazz groove run email-cleanup

# Run with auto-approve
jazz groove run email-cleanup --auto-approve

# Run with a specific agent
jazz groove run email-cleanup --agent research-bot
```

### Schedule Grooves

```bash
# Schedule a groove for periodic execution
jazz groove schedule email-cleanup

# If the groove doesn't specify an agent, you'll be prompted to select one

# View all scheduled grooves
jazz groove scheduled

# Remove a groove from the schedule
jazz groove unschedule email-cleanup
```

### When do scheduled runs happen?

Scheduled grooves use the **system scheduler** (launchd on macOS, cron on Linux). The OS only runs jobs when the machine is awake, if the computer is asleep or off at the scheduled time, that run is skipped. The system does not queue or replay missed runs when you wake the machine.

**Jazz's catch-up feature** addresses this: you can run missed grooves when you're back at your computer.

- **Interactive catch-up**: If any groove has `catchUpOnStartup: true` and missed its scheduled time (within `maxCatchUpAge`), the next time you run any `jazz` command (e.g. `jazz chat` or `jazz groove list`), Jazz will notify you and ask if you'd like to catch them up. If you say yes, you can select which grooves to run (multi-select), and they'll run in the background while you continue with your original command.\_
- **Manual catch-up**: Run `jazz groove catchup` to see all grooves that need catch-up, choose which to run, and run them.

For more detail (including why this happens and other options), see [Workflow scheduling: behavior & limitations](workflows-scheduling.md).

### Catch-up missed runs

When you start Jazz with pending catch-up grooves:

```
$ jazz chat
⚠️  2 grooves need to catch up:
   • market-analysis (missed 6:00 AM today)
   • tech-digest (missed 8:00 AM today)

Would you like to catch them up? (y/n): y

Select grooves to catch up:
  [x] market-analysis
  [x] tech-digest

Running selected grooves in background...
Starting chat session...
```

You can also run catch-up manually anytime:

```bash
# List grooves that missed a run, select which to run, then run them
jazz groove catchup
```

Shows grooves that are scheduled, have `catchUpOnStartup: true`, and missed their last run within the max catch-up window. You can select which ones to run (multi-select with Space, confirm with Enter).

### View History

```bash
# View recent groove runs (all grooves)
jazz groove history

# View history for a specific groove
jazz groove history email-cleanup
```

## Example Grooves

### Email Cleanup (Hourly)

**File**: `~/.jazz/grooves/email-cleanup/GROOVE.md`

```markdown
---
name: email-cleanup
description: Clean up newsletters and promotional emails
schedule: "0 * * * *"
autoApprove: low-risk
skills:
  - email
---

# Email Cleanup

Review my inbox from the last hour and archive:

- Newsletters older than 2 weeks
- Promotional emails older than 3 days
- GitHub notifications I've already seen

**When in doubt, don't archive anything.**
```

### Morning Weather Briefing

**File**: `~/.jazz/grooves/weather-briefing/GROOVE.md`

```markdown
---
name: weather-briefing
description: Morning weather and outfit recommendations
schedule: "0 7 * * *"
autoApprove: read-only
---

# Morning Weather Briefing

Check today's weather and suggest what to wear.
Keep it brief - this is a quick morning glance.
```

### Daily Tech Digest

**File**: `./grooves/tech-digest/GROOVE.md`

```markdown
---
name: tech-digest
description: Daily AI & tech trends digest
schedule: "0 8 * * *"
autoApprove: true
skills:
  - deep-research
---

# Daily Tech & AI Digest

Research and summarize the most important AI and tech news
from the last 24 hours. Save to ~/tech-digests/YYYY/Month/DD.md

Sources: Twitter, Reddit, Hugging Face, Hacker News, TechCrunch...
```

### Market Analysis (Daily)

**File**: `./grooves/market-analysis/GROOVE.md`

```markdown
---
name: market-analysis
description: Daily stock market and crypto analysis
schedule: "0 6 * * *"
autoApprove: true
catchUpOnStartup: true
maxCatchUpAge: 43200
skills:
  - deep-research
---

# Daily Market Analysis

Comprehensive analysis of S&P 500, major stocks (AAPL, TSLA, NVDA),
and crypto (BTC, ETH) with buy/sell recommendations.

Save to ~/market-analysis/YYYY/MM/DD.md
```

## How Scheduling Works

### macOS (launchd)

Jazz creates a plist file at `~/Library/LaunchAgents/com.jazz.groove.<name>.plist` that tells macOS when to run your groove.

View logs: `~/.jazz/logs/<workflow-name>.log`

### Linux (cron)

Jazz adds an entry to your user crontab. View with `crontab -l`.

View logs: `~/.jazz/logs/<workflow-name>.log`

### ⚠️ Important: Computer Must Be Awake

**Scheduled grooves only run if your computer is powered on and awake at the scheduled time.**

If your computer is closed, asleep, or off when a groove is scheduled:

- ❌ The groove will NOT run at that time
- ✅ It WILL run at the next scheduled time (if computer is awake)
- ✅ You can enable catch-up on startup (see below)

**Solutions:**

1. **Keep your computer awake** during times when workflows should run
2. **Run Jazz on an always-on device** (Raspberry Pi, server, cloud VM)
3. **Schedule workflows** when you know your computer will be on
4. **Run manually** when needed: `jazz workflow run <name>`

### ✅ Catch-Up on Startup

Enable catch-up to prompt for missed grooves when Jazz starts:

```yaml
---
catchUpOnStartup: true
maxCatchUpAge: 43200 # seconds (12 hours)
---
```

If a scheduled run was missed and is within `maxCatchUpAge`, Jazz will notify you when you run any command and ask if you'd like to catch up. You can select which grooves to run, and they'll execute in the background while you continue with your original command.

See [Groove Scheduling Behavior](./scheduling.md) for detailed information and workarounds.

## Run History & Logs

Every groove execution is tracked:

- **Run history**: `~/.jazz/run-history.json` (last 100 runs)
- **Logs**: `~/.jazz/logs/<groove-name>.log`
- **Schedule metadata**: `~/.jazz/schedules/<groove-name>.json`

View history with:

```bash
jazz workflow history
```

## Best Practices

### 1. Start Conservative

Use `autoApprove: read-only` for research/monitoring grooves, then increase to `low-risk` or `high-risk` once you trust the groove.

### 2. Be Explicit About Safety

Include safety guidelines in your groove prompt:

```markdown
**Safety Rules:**

- When in doubt, DO NOTHING
- Only perform actions you're 100% confident about
- Leave uncertain items for manual review
```

### 3. Test Manually First

Before scheduling, run the groove manually to verify it works:

```bash
jazz groove run my-groove
```

### 4. Choose the Right Agent

Different grooves may need different agents:

- Research grooves → agent with strong reasoning
- Email management → agent with email tools enabled
- Code tasks → agent with filesystem and git tools

### 5. Monitor Logs

Check logs after scheduled runs to ensure everything works:

```bash
tail -f ~/.jazz/logs/email-cleanup.log
```

## Troubleshooting

### Groove Not Running

1. **Check if it's scheduled**: `jazz groove scheduled`
2. **Verify the agent exists**: `jazz agent list`
3. **Check logs**: `~/.jazz/logs/<groove-name>.log`
4. **Check system scheduler**:
   - macOS: `launchctl list | grep jazz`
   - Linux: `crontab -l | grep jazz`

### Agent Not Found During Scheduled Run

The agent must exist when the groove runs. If you delete an agent that's used by a scheduled groove, the groove will fail. Update the schedule with a new agent:

```bash
jazz groove unschedule my-groove
jazz groove schedule my-groove
# Select a different agent
```

### Groove Asks for Approval Despite autoApprove

Make sure you're using `--auto-approve` when running manually:

```bash
jazz groove run my-groove --auto-approve
```

For scheduled runs, auto-approve is automatically enabled based on the groove's `autoApprove` setting.

## Advanced Usage

### Using the Create-Groove Skill

Jazz includes a `create-groove` skill that helps you generate grooves interactively:

```bash
# Start a chat with your agent
jazz

# Then ask:
> Create a groove that checks my email every hour and archives old newsletters

# Or:
> Help me automate checking GitHub issues every morning
```

The skill will:

1. Ask clarifying questions (schedule, safety level, output location)
2. Generate the complete `GROOVE.md` file
3. Suggest next steps (testing, scheduling)

This is the easiest way to create grooves - the agent will handle all the formatting, cron syntax, and safety guidelines.

### Skills Integration

Grooves can reference skills in their prompt:

```markdown
---
skills:
  - deep-research
  - email
---

Use the `deep-research` skill to investigate...
```

The agent will automatically have access to load and use these skills.

### Conditional Logic

You can include conditional instructions in your groove prompt:

```markdown
If there are more than 10 emails to clean up, create a summary
and save it to ~/email-cleanup-summary.md

Otherwise, just log the count.
```

### Multi-Step Grooves

Break complex grooves into clear steps:

```markdown
# Daily Standup Report

1. Check my calendar for today's meetings
2. Review open GitHub issues assigned to me
3. Summarize unread Slack messages
4. Generate a brief standup report
5. Save to ~/standups/YYYY-MM-DD.md
```

## Security & Privacy

- **Credentials**: Grooves use the same OAuth2 tokens as interactive sessions
- **Approval**: Auto-approve only applies to tools matching the risk policy
- **Logs**: All actions are logged to `~/.jazz/logs/`
- **Audit Trail**: Full run history in `~/.jazz/run-history.json`

## What's Next

Future enhancements planned:

- **File triggers**: Run grooves when files change
- **Webhook triggers**: HTTP endpoints to trigger grooves
- **Groove dependencies**: Chain grooves together
- **Retry policies**: Automatic retry on failure
- **Notifications**: Desktop/email notifications on completion

See [`TODO.md`](../TODO.md) for the full roadmap.

## Examples

See the `grooves/` directory for complete examples:

- [`grooves/email-cleanup/`](../grooves/email-cleanup/GROOVE.md) - Hourly email management
- [`grooves/weather-briefing/`](../grooves/weather-briefing/GROOVE.md) - Morning weather check
- [`grooves/tech-digest/`](../grooves/tech-digest/GROOVE.md) - Daily AI/tech news digest
- [`grooves/market-analysis/`](../grooves/market-analysis/GROOVE.md) - Daily stock market & crypto analysis
