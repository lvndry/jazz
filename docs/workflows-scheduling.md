# Workflow Scheduling: Behavior & Limitations

## How Scheduling Works

Jazz uses your operating system's built-in scheduler:
- **macOS**: `launchd` (via `~/Library/LaunchAgents/`)
- **Linux**: `cron` (via `crontab`)

## ⚠️ Important: Computer Must Be Awake at Schedule Time

If your computer is **closed, asleep, or powered off** when a workflow is scheduled to run:
- ❌ The system scheduler will **not** run it at that time (the event is missed)
- ✅ It **will** run at the next scheduled time if your computer is awake
- ✅ With **catch-up on startup** (`catchUpOnStartup: true` in the workflow), Jazz will prompt you to run missed workflows when you next run any Jazz command (within `maxCatchUpAge`)

### Example Scenarios

#### Scenario 1: Daily Market Analysis at 6 AM
```
Schedule: 0 6 * * *

Monday 6 AM: Computer closed → ❌ Job skipped
Monday 8 AM: You open laptop, run `jazz chat` → Jazz asks if you want to catch up
Tuesday 6 AM: Computer awake → ✅ Job runs
```

#### Scenario 2: Hourly Email Cleanup
```
Schedule: 0 * * * *

2:00 PM: Computer awake → ✅ Job runs
3:00 PM: You close laptop → ❌ Job skipped
4:00 PM: Still closed → ❌ Job skipped
5:00 PM: You open laptop, run `jazz` → Jazz asks if you want to catch up
6:00 PM: Computer awake → ✅ Job runs
```

## Why This Happens

### macOS launchd
- Uses `StartCalendarInterval` which only fires at exact calendar times
- If the system is asleep, the event is simply missed
- Catch-up can be enabled per workflow (`catchUpOnStartup`) - Jazz will prompt you when you run any command

### Linux cron
- Cron only runs when the system is on
- Standard cron has no concept of "missed jobs"
- `anacron` exists for this, but requires additional setup

## Solutions & Workarounds

### 1. Keep Your Computer Awake (Easiest)

#### macOS
```bash
# Prevent sleep indefinitely
caffeinate

# Prevent sleep for specific duration
caffeinate -t 28800  # 8 hours

# Prevent sleep while charging
# System Preferences → Battery → Power Adapter → Prevent automatic sleeping
```

#### Linux
```bash
# Disable suspend
sudo systemctl mask sleep.target suspend.target

# Or use caffeine
sudo apt install caffeine
```

### 2. Use an Always-On Device (Recommended)

Run Jazz on a machine that's always powered on:

**Home Server Options:**
- **Raspberry Pi 4/5** ($35-75): Perfect for running Jazz 24/7
- **Intel NUC / Mac Mini**: More powerful, still energy efficient
- **Old laptop**: Leave it plugged in and running
- **NAS**: Synology, QNAP if it supports Node.js

**Cloud Options:**
- **AWS EC2 t4g.micro**: ~$3-6/month
- **DigitalOcean Droplet**: $6/month
- **Hetzner Cloud**: €4.5/month
- **Oracle Cloud Free Tier**: Actually free forever

### 3. Schedule When You're Awake

Adjust schedules to times when you know your computer will be on:

```yaml
# Instead of: 6 AM (you might be asleep)
schedule: "0 6 * * *"

# Use: 9 AM (you're at your computer)
schedule: "0 9 * * *"

# Or: Every 2 hours during work hours
schedule: "0 9-17/2 * * 1-5"
```

### 4. Run Manually When Needed

```bash
# Run a workflow anytime manually
jazz workflow run market-analysis

# Run with auto-approve (same as scheduled)
jazz workflow run market-analysis --auto-approve
```

### 5. Catch-Up on Startup (Available)

**Catch-up on startup is now supported** and can be enabled per workflow:

What it does:
- Tracks last successful run time
- On startup, checks if scheduled runs were missed (when Jazz starts)
- Notifies you and asks if you'd like to catch up missed workflows
- Lets you select which workflows to run (multi-select)
- Runs selected workflows in the background so you can continue with your original command

Example config:
```yaml
---
name: market-analysis
schedule: "0 6 * * *"
catchUpOnStartup: true  # Prompt if missed
maxCatchUpAge: 86400    # Only catch up if < 24h old
---
```

Example interaction:
```
$ jazz chat
⚠️  2 workflows need to catch up:
   • market-analysis (missed 6:00 AM today)
   • tech-digest (missed 8:00 AM today)

Would you like to catch them up? (y/n): y

Select workflows to catch up:
  [x] market-analysis
  [x] tech-digest

Running selected workflows in background...
Starting chat session...
```

## Best Practices by Workflow Type

### Critical Workflows (Must Not Miss)
**Examples**: Trading signals, important alerts, time-sensitive automation

**Solution**: Run on an always-on device (Raspberry Pi, cloud server)

### Nice-to-Have Workflows
**Examples**: News digests, research summaries, casual monitoring

**Solution**: Schedule when you're typically at your computer, or run manually when needed

### Flexible Timing Workflows
**Examples**: Weekly reports, cleanup tasks, non-urgent analysis

**Solution**: Use longer intervals that increase chance of catching the schedule
```yaml
# Instead of daily at specific time
schedule: "0 6 * * *"

# Use every 6 hours (multiple chances)
schedule: "0 */6 * * *"
```

## Checking If Your Schedule Worked

### View Last Run Time

```bash
# Check workflow history
jazz workflow history market-analysis

# View logs
tail -100 ~/.jazz/logs/market-analysis.log

# Check system scheduler
# macOS:
launchctl list | grep jazz

# Linux:
crontab -l
```

### Monitor Scheduled Jobs

```bash
# List all scheduled workflows
jazz workflow scheduled

# Check when each should run next
ls -la ~/Library/LaunchAgents/com.jazz.workflow.*.plist  # macOS
```

## Technical Details

### Why Not Use StartInterval?

launchd has `StartInterval` (run every N seconds) which DOES catch up after sleep, but:
- ❌ Can't specify exact times (6 AM, Monday 9 AM, etc.)
- ❌ Drifts over time (not aligned to calendar)
- ❌ Less intuitive than cron syntax

We chose `StartCalendarInterval` for:
- ✅ Exact calendar timing (6 AM every day)
- ✅ Standard cron syntax
- ✅ Predictable schedule
- ⚠️ Catch-up is configured per-workflow via `catchUpOnStartup` (prompts user on next Jazz command)

### Why Not Use anacron?

Linux has `anacron` which handles missed jobs, but:
- Requires root/sudo to set up
- Not available on macOS
- More complex configuration
- Jazz aims to work without sudo

## Frequently Asked Questions

### Q: Will my workflow run if I wake my laptop 10 minutes after scheduled time?
**A**: By default, no. The schedule event was missed. If you enable `catchUpOnStartup`, Jazz will notify you the next time you run any command and ask if you'd like to catch up the missed workflow.

### Q: Can I make workflows catch up?
**A**: Yes. Enable `catchUpOnStartup: true` in the workflow frontmatter and set `maxCatchUpAge` (seconds) to control how old a missed run can be. When you next run any Jazz command, you'll be prompted to select which missed workflows to run, and they'll execute in the background.

```yaml
catchUpOnStartup: true
maxCatchUpAge: 43200  # 12 hours
```

### Q: What if I need critical workflows to never miss?
**A**: Run Jazz on an always-on device (Raspberry Pi, cloud server, NAS, etc.)

### Q: Can I get notified when a workflow is skipped?
**A**: Not currently. You can check run history to see gaps:
```bash
jazz workflow history market-analysis
```

### Q: Does this affect manual runs?
**A**: No. `jazz workflow run <name>` always works immediately, regardless of schedule.

### Q: What about workflows on cloud servers?
**A**: If Jazz is on an always-on cloud server, all scheduled workflows run reliably.

## Implementation Recommendations

### For Home Users
1. Schedule workflows during times you're typically at your computer
2. Run important workflows manually when you open your laptop
3. Consider a Raspberry Pi for critical workflows ($35-75 one-time cost)

### For Professional Use
1. Deploy Jazz on a cloud server or home server
2. Use systemd services or Docker to ensure Jazz is always running
3. Set up monitoring and alerts for workflow execution

### For Development/Testing
1. Use shorter intervals during testing (every 5 minutes)
2. Test that workflows work when run manually
3. Check logs after expected run time to confirm execution

## Related Documentation

- [Workflow System Overview](./workflows.md)
- [Creating Workflows](./workflows.md#quick-start)
- [Troubleshooting Workflows](./workflows.md#troubleshooting)
- [Running Jazz on a Server](./deployment.md) *(future)*

---

**Summary**: Scheduled workflows only run if your computer is awake at the scheduled time. For reliable 24/7 automation, run Jazz on an always-on device like a Raspberry Pi, server, or cloud VM.
