# Workflows - Automated Agent Tasks

Workflows let you automate recurring tasks by scheduling agents to run at specific times. Think of them as "cron jobs for AI agents" - scheduled automation that can read your emails, research topics, manage your calendar, and more.

## Quick Start

**💡 Tip**: Use the `create-workflow` skill to generate workflows interactively. Just ask your agent: *"Create a workflow to clean my email every hour"* and it will guide you through the process.

### 1. Create a Workflow

Create a `WORKFLOW.md` file in one of these locations:

- **Local** (project-specific): `./workflows/<name>/WORKFLOW.md`
- **Global** (user-wide): `~/.jazz/workflows/<name>/WORKFLOW.md`
- **Built-in** (shipped with Jazz): `<jazz-install>/workflows/<name>/WORKFLOW.md`

### 2. Define the Workflow

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
# List available workflows
jazz workflow list

# Schedule the workflow
jazz workflow schedule email-cleanup

# View scheduled workflows
jazz workflow scheduled

# Check run history
jazz workflow history email-cleanup
```

## Workflow File Format

### Frontmatter Fields

| Field              | Required | Description                                       | Example                                               |
| ------------------ | -------- | ------------------------------------------------- | ----------------------------------------------------- |
| `name`             | ✓        | Unique workflow identifier                        | `email-cleanup`                                       |
| `description`      | ✓        | Human-readable summary                            | `Clean up old emails`                                 |
| `schedule`         |          | Cron expression for scheduling                    | `0 8 * * *` (daily at 8 AM)                           |
| `agent`            |          | Agent ID/name to use (defaults to user selection) | `research-bot`                                        |
| `autoApprove`      |          | Auto-approval policy for unattended runs          | `true`, `false`, `read-only`, `low-risk`, `high-risk` |
| `skills`           |          | Skills to load for this workflow                  | `["email", "calendar"]`                               |
| `catchUpOnStartup` |          | Run missed workflows on startup                   | `true`                                                |
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

### List Workflows

```bash
# List all available workflows
jazz workflow list

# Show detailed information about a workflow
jazz workflow show tech-digest
```

### Run Workflows

```bash
# Run a workflow once (manually)
jazz workflow run email-cleanup

# Run with auto-approve
jazz workflow run email-cleanup --auto-approve

# Run with a specific agent
jazz workflow run email-cleanup --agent research-bot
```

### Schedule Workflows

```bash
# Schedule a workflow for periodic execution
jazz workflow schedule email-cleanup

# If the workflow doesn't specify an agent, you'll be prompted to select one

# View all scheduled workflows
jazz workflow scheduled

# Remove a workflow from the schedule
jazz workflow unschedule email-cleanup
```

### When do scheduled runs happen?

Scheduled workflows use the **system scheduler** (launchd on macOS, cron on Linux). Jobs run **only when the machine is awake**. If your Mac is asleep or shut down at the scheduled time, that run is skipped—there is no “queue” that runs everything when you wake the machine.

To handle missed runs:

- **Automatic catch-up**: If a workflow has `catchUpOnStartup: true`, the next time you run any `jazz` command (e.g. `jazz chat` or `jazz workflow list`), Jazz will run that workflow once in the background if it missed its last scheduled time (within `maxCatchUpAge`).
- **Manual catch-up**: Run `jazz workflow catchup` to see all workflows that need catch-up, choose which to run, and run them.

### Catch-up missed runs

```bash
# List workflows that missed a run, select which to run, then run them
jazz workflow catchup
```

Shows workflows that are scheduled, have `catchUpOnStartup: true`, and missed their last run within the max catch-up window. You can select which ones to run (multi-select with Space, confirm with Enter). Useful when you’ve been away and want to run missed workflows on demand instead of waiting for the next `jazz` command.

### View History

```bash
# View recent workflow runs (all workflows)
jazz workflow history

# View history for a specific workflow
jazz workflow history email-cleanup
```

## Example Workflows

### Email Cleanup (Hourly)

**File**: `~/.jazz/workflows/email-cleanup/WORKFLOW.md`

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

**File**: `~/.jazz/workflows/weather-briefing/WORKFLOW.md`

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

**File**: `./workflows/tech-digest/WORKFLOW.md`

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

**File**: `./workflows/market-analysis/WORKFLOW.md`

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

Jazz creates a plist file at `~/Library/LaunchAgents/com.jazz.workflow.<name>.plist` that tells macOS when to run your workflow.

View logs: `~/.jazz/logs/<workflow-name>.log`

### Linux (cron)

Jazz adds an entry to your user crontab. View with `crontab -l`.

View logs: `~/.jazz/logs/<workflow-name>.log`

### ⚠️ Important: Computer Must Be Awake

**Scheduled workflows only run if your computer is powered on and awake at the scheduled time.**

If your computer is closed, asleep, or off when a workflow is scheduled:
- ❌ The workflow will NOT run at that time
- ✅ It WILL run at the next scheduled time (if computer is awake)
- ✅ You can enable catch-up on startup (see below)

**Solutions:**
1. **Keep your computer awake** during times when workflows should run
2. **Run Jazz on an always-on device** (Raspberry Pi, server, cloud VM)
3. **Schedule workflows** when you know your computer will be on
4. **Run manually** when needed: `jazz workflow run <name>`

### ✅ Catch-Up on Startup (New)

Enable catch-up to run missed workflows when Jazz starts:

```yaml
---
catchUpOnStartup: true
maxCatchUpAge: 43200  # seconds (12 hours)
---
```

If a scheduled run was missed and is within `maxCatchUpAge`, Jazz will execute it once when you start Jazz (any `jazz` command).

See [Workflow Scheduling Behavior](./workflows-scheduling.md) for detailed information and workarounds.

## Run History & Logs

Every workflow execution is tracked:

- **Run history**: `~/.jazz/run-history.json` (last 100 runs)
- **Logs**: `~/.jazz/logs/<workflow-name>.log`
- **Schedule metadata**: `~/.jazz/schedules/<workflow-name>.json`

View history with:
```bash
jazz workflow history
```

## Best Practices

### 1. Start Conservative

Use `autoApprove: read-only` for research/monitoring workflows, then increase to `low-risk` or `high-risk` once you trust the workflow.

### 2. Be Explicit About Safety

Include safety guidelines in your workflow prompt:
```markdown
**Safety Rules:**
- When in doubt, DO NOTHING
- Only perform actions you're 100% confident about
- Leave uncertain items for manual review
```

### 3. Test Manually First

Before scheduling, run the workflow manually to verify it works:
```bash
jazz workflow run my-workflow
```

### 4. Choose the Right Agent

Different workflows may need different agents:
- Research workflows → agent with strong reasoning
- Email management → agent with email tools enabled
- Code tasks → agent with filesystem and git tools

### 5. Monitor Logs

Check logs after scheduled runs to ensure everything works:
```bash
tail -f ~/.jazz/logs/email-cleanup.log
```

## Troubleshooting

### Workflow Not Running

1. **Check if it's scheduled**: `jazz workflow scheduled`
2. **Verify the agent exists**: `jazz agent list`
3. **Check logs**: `~/.jazz/logs/<workflow-name>.log`
4. **Check system scheduler**:
   - macOS: `launchctl list | grep jazz`
   - Linux: `crontab -l | grep jazz`

### Agent Not Found During Scheduled Run

The agent must exist when the workflow runs. If you delete an agent that's used by a scheduled workflow, the workflow will fail. Update the schedule with a new agent:

```bash
jazz workflow unschedule my-workflow
jazz workflow schedule my-workflow
# Select a different agent
```

### Workflow Asks for Approval Despite autoApprove

Make sure you're using `--auto-approve` when running manually:
```bash
jazz workflow run my-workflow --auto-approve
```

For scheduled runs, auto-approve is automatically enabled based on the workflow's `autoApprove` setting.

## Advanced Usage

### Using the Create-Workflow Skill

Jazz includes a `create-workflow` skill that helps you generate workflows interactively:

```bash
# Start a chat with your agent
jazz

# Then ask:
> Create a workflow that checks my email every hour and archives old newsletters

# Or:
> Help me automate checking GitHub issues every morning
```

The skill will:
1. Ask clarifying questions (schedule, safety level, output location)
2. Generate the complete `WORKFLOW.md` file
3. Suggest next steps (testing, scheduling)

This is the easiest way to create workflows - the agent will handle all the formatting, cron syntax, and safety guidelines.

### Skills Integration

Workflows can reference skills in their prompt:

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

You can include conditional instructions in your workflow prompt:

```markdown
If there are more than 10 emails to clean up, create a summary
and save it to ~/email-cleanup-summary.md

Otherwise, just log the count.
```

### Multi-Step Workflows

Break complex workflows into clear steps:

```markdown
# Daily Standup Report

1. Check my calendar for today's meetings
2. Review open GitHub issues assigned to me
3. Summarize unread Slack messages
4. Generate a brief standup report
5. Save to ~/standups/YYYY-MM-DD.md
```

## Security & Privacy

- **Credentials**: Workflows use the same OAuth2 tokens as interactive sessions
- **Approval**: Auto-approve only applies to tools matching the risk policy
- **Logs**: All actions are logged to `~/.jazz/logs/`
- **Audit Trail**: Full run history in `~/.jazz/run-history.json`

## What's Next

Future enhancements planned:
- **File triggers**: Run workflows when files change
- **Webhook triggers**: HTTP endpoints to trigger workflows
- **Workflow dependencies**: Chain workflows together
- **Retry policies**: Automatic retry on failure
- **Notifications**: Desktop/email notifications on completion

See [`TODO.md`](../TODO.md) for the full roadmap.

## Examples

See the `workflows/` directory for complete examples:
- [`workflows/email-cleanup/`](../workflows/email-cleanup/WORKFLOW.md) - Hourly email management
- [`workflows/weather-briefing/`](../workflows/weather-briefing/WORKFLOW.md) - Morning weather check
- [`workflows/tech-digest/`](../workflows/tech-digest/WORKFLOW.md) - Daily AI/tech news digest
- [`workflows/market-analysis/`](../workflows/market-analysis/WORKFLOW.md) - Daily stock market & crypto analysis
