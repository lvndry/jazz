# Security Guide

Understanding Jazz's security model and best practices for safe agent operation.

## Security Philosophy

Jazz is designed with a **trust-but-verify** security model:

- **Agents are powerful**: They can execute commands, modify files, and manage emails
- **Users are in control**: Dangerous operations always require explicit approval
- **Transparency first**: All actions are visible and logged
- **Defense in depth**: Multiple security layers protect your system

## ⚠️ Understanding the Risks

### What Agents Can Do

When you give an agent tools, it can:

**With Gmail Tools:**

- Read all your emails
- Send emails on your behalf
- Delete emails permanently (with approval)
- Manage labels and filters

**With Git Tools:**

- Read repository contents
- Commit changes (with approval)
- Push to remote (with approval)
- Delete branches (with approval)

**With File Tools:**

- Read any file you can access
- Write files (with approval)
- Delete files (with approval)
- Navigate your file system

**With Shell Tools:**

- Execute commands (with approval)
- Install packages (with approval)
- Run scripts (with approval)
- Access network resources

### Potential Risks

1. **Data Loss**: Agents could delete important files or emails
2. **Unintended Actions**: Misunderstood requests could lead to wrong operations
3. **Credential Exposure**: API keys and tokens could be logged or exposed
4. **System Modification**: Commands could alter system state
5. **Resource Usage**: Operations could consume CPU, memory, or bandwidth

## 🛡️ Security Features

### 1. User Approval System

Dangerous operations always require explicit approval.

**How It Works:**

```
You: Delete all spam emails

Agent: [Searches for spam emails]

📧 Found 127 emails with label "spam"

⚠️ About to PERMANENTLY DELETE 127 emails. This cannot be undone!

Sample emails:
- "Get rich quick!" from spam@example.com (30 days old)
- "You won a prize!" from fake@example.com (45 days old)
- ...

Do you want me to proceed? (yes/no)

You: yes

Agent: [Executes deletion]
✓ Deleted 127 emails successfully.
```

**Approval Required For:**

- Email deletion (trash or permanent)
- File deletion
- File/directory creation
- Git commits and pushes
- Shell command execution
- Label deletion

### 2. Command Filtering

Shell commands are checked against 40+ dangerous patterns.

**Blocked Commands:**

| Category                 | Examples                             | Why Blocked                    |
| ------------------------ | ------------------------------------ | ------------------------------ |
| **File Destruction**     | `rm -rf /`, `rm -rf ~`, `rm *`       | Could delete entire systems    |
| **Privilege Escalation** | `sudo`, `su`                         | Could gain root access         |
| **Remote Execution**     | `curl ... \| sh`, `wget ... \| bash` | Could download and run malware |
| **Process Manipulation** | `kill -9`, `pkill`, `killall`        | Could kill critical processes  |
| **System Commands**      | `shutdown`, `reboot`, `halt`         | Could shut down system         |
| **Fork Bombs**           | `:(){ :\|:& };:`                     | Could exhaust resources        |

**Example:**

```
You: Run sudo apt-get install

Agent: ❌ Command appears to be potentially dangerous and was blocked for safety.

The command contains 'sudo' which could escalate privileges.

If you need to run this command, please execute it manually in your terminal.
```

### 3. Environment Sanitization

When executing shell commands, Jazz:

**Removes:**

- API keys (vars containing "API", "KEY", "SECRET")
- Tokens (vars containing "TOKEN", "PASSWORD")
- Credentials (vars containing "CREDENTIAL", "AUTH")

**Keeps:**

- PATH (for command resolution)
- HOME (for home directory)
- USER (for user identification)
- SHELL (for shell type)

**Example:**

```typescript
// Before sanitization
process.env = {
  PATH: "/usr/local/bin:/usr/bin",
  OPENAI_API_KEY: "sk-...", // ⚠️ Sensitive
  HOME: "/Users/you",
  AWS_SECRET_KEY: "...", // ⚠️ Sensitive
};

// After sanitization
sanitizedEnv = {
  PATH: "/usr/local/bin:/usr/bin", // ✓ Safe
  HOME: "/Users/you", // ✓ Safe
  USER: "you", // ✓ Safe
  SHELL: "/bin/zsh", // ✓ Safe
};
```

### 4. Security Logging

All command executions are logged for audit purposes.

**Log Format:**

```
🔒 SECURITY LOG: Command executed by agent {agentId}: {
  command: "npm install",
  workingDirectory: "/path/to/project",
  exitCode: 0,
  timestamp: "2025-01-15T10:30:00.000Z",
  agentId: "agent-123",
  conversationId: "conv-456"
}
```

**What's Logged:**

- All shell command executions
- File write operations
- File deletions
- Git push operations
- Email deletions

**Where Logs Are:**

- Console output
- Agent execution logs
- Can be redirected to files

### 5. Path Validation

File operations validate paths to prevent security issues:

**Prevents:**

- Path traversal attacks (`../../../etc/passwd`)
- Symbolic link exploits
- Access to system directories (without approval)

**Example:**

```
You: Read /etc/shadow

Agent: ❌ Access denied to system file for security reasons.

System files require manual access for safety.
```

### 6. Timeout Protection

All operations have maximum execution times:

**Default Timeouts:**

- Shell commands: 30 seconds
- File operations: 10 seconds
- API requests: 30 seconds
- Git operations: 60 seconds

**Why Important:**

- Prevents runaway processes
- Stops infinite loops
- Protects against resource exhaustion
- Ensures responsive agents

### 7. Process Isolation

Commands run with restrictions:

**Isolation Features:**

- Same user privileges as Jazz process
- No detached processes (can be terminated)
- Timeout enforcement
- Resource limits (where supported)

**Cannot:**

- Escalate privileges
- Fork bomb the system
- Access root resources (without sudo)
- Bypass user permissions

## 🔐 Best Practices

### Before Using Jazz

1. **Understand Your System**: Know what you're protecting
2. **Run with Minimal Privileges**: Don't run Jazz as root
3. **Backup Important Data**: Ensure backups are current
4. **Review Configuration**: Check what tools agents have access to
5. **Set Up Monitoring**: Know how to check logs

### When Creating Agents

1. **Principle of Least Privilege**: Only give tools the agent needs
2. **Clear Purpose**: Define specific agent responsibilities
3. **Test in Safe Environment**: Try agents in test directories first
4. **Document Intent**: Write clear agent descriptions

**Example:**

```bash
# Good - specific tools for specific purpose
jazz agent create email-helper --tools gmail

# Less good - unnecessary access
jazz agent create email-helper --tools gmail,git,shell,filesystem
```

### During Agent Use

1. **Always Review Approvals**: Read approval messages carefully
2. **Verify Context**: Check working directory before approving
3. **Understand Commands**: Don't approve commands you don't understand
4. **Monitor Behavior**: Watch what agents are doing
5. **Use /status**: Check conversation context regularly

**Approval Checklist:**

```
Before approving:
□ Do I understand what this will do?
□ Am I in the right directory?
□ Are the file paths correct?
□ Is this reversible if something goes wrong?
□ Do I have backups if needed?
```

### For Gmail Operations

1. **Start Small**: Test with a few emails before bulk operations
2. **Use Trash First**: Trash emails before permanent deletion
3. **Check Search Results**: Verify email counts before deletion
4. **Backup Important Emails**: Export critical emails
5. **Review Label Changes**: Understand label implications

**Example Flow:**

```
You: Delete old newsletters

Agent: Found 500 emails matching "category:promotions older_than:30d"

You: Actually, let's just trash 10 to test

Agent: [Trashes 10 emails]
✓ Moved 10 emails to trash

You: Good, now trash the rest

Agent: [Requests approval for 490 emails]
```

### For File Operations

1. **Use Absolute Paths**: Avoid ambiguity
2. **Check pwd First**: Know your working directory
3. **Test with ls**: List directory contents before operations
4. **Start with Read Operations**: Understand before modifying
5. **Backup Before Deletion**: Copy important files first

**Example:**

```
You: Show me what's in the current directory

Agent: [Runs ls]
.
├── important.txt
├── temp/
└── backup/

You: Delete the temp folder

Agent: About to delete directory ./temp (2 files, 145 KB)
Proceed? (yes/no)
```

### For Git Operations

1. **Check Status First**: Run git status before commits
2. **Review Diffs**: See what's changed before committing
3. **Test Branches**: Use feature branches for experiments
4. **Verify Remote**: Check remote before pushing
5. **Never Force Push to Main**: Use `--no-ff` for main branch

### For Shell Commands

1. **Understand the Command**: Know what it does
2. **Check Working Directory**: Verify location
3. **Review Command Output**: Read approval details
4. **Test in Safe Location**: Try in test directories
5. **Avoid Piped Commands**: Prefer explicit steps

**Safe Commands:**

```bash
# Good - explicit and safe
npm install
git status
ls -la
cat package.json
```

**Risky Commands:**

```bash
# Be careful with these
rm -rf node_modules  # Could delete wrong folder
npm install -g       # Installs globally
chmod 777 *          # Too permissive
curl ... | sh        # Blocked by Jazz
```

## 🚨 Security Incidents

### If Something Goes Wrong

1. **Stop Immediately**: Exit the agent conversation (`exit`)
2. **Assess Damage**: Check what was affected
3. **Review Logs**: Look at security logs
4. **Restore from Backup**: If data was lost
5. **Report Issue**: Help improve Jazz security

### Log Analysis

Check security logs for suspicious activity:

```bash
# Search logs for command executions
grep "SECURITY LOG" ~/.jazz/logs/

# Check recent operations
tail -100 ~/.jazz/logs/agent-operations.log
```

### Recovery Steps

**For Deleted Files:**

1. Check trash/recycle bin
2. Restore from backup
3. Use file recovery tools if needed

**For Git Issues:**

1. Check reflog: `git reflog`
2. Reset to previous state: `git reset --hard <commit>`
3. Recover from remote: `git fetch origin && git reset --hard origin/main`

**For Email Issues:**

1. Check Gmail trash (30-day retention)
2. Contact Gmail support for recovery
3. Restore from backup if available

## 📊 Security Audit

### Regular Checks

Perform these security checks regularly:

**Weekly:**

- Review command execution logs
- Check for unexpected file changes
- Verify agent configurations
- Review approval patterns

**Monthly:**

- Audit API key usage
- Review agent permissions
- Update security policies
- Check for software updates

### Security Checklist

```
□ Agents have minimum required tools
□ Approval system is working correctly
□ Logs are being captured
□ Backups are current
□ API keys are secure
□ No unexpected behavior observed
□ Jazz is up to date
```

## 🔒 Additional Security Measures

### 1. Use Separate Accounts

For sensitive operations:

```bash
# Create a dedicated Gmail account for automation
# Use a separate GitHub account for bot operations
# Run Jazz in a dedicated user account
```

### 2. Container Isolation (Advanced)

Run Jazz in Docker for additional isolation:

```dockerfile
FROM node:18-alpine
RUN npm install -g jazz-ai
USER node
WORKDIR /home/node
CMD ["jazz"]
```

### 3. Network Restrictions

Limit network access if possible:

- Use firewall rules
- Restrict API endpoints
- Monitor network traffic
- Use VPN for sensitive operations

### 4. File System Permissions

Restrict file access:

```bash
# Create a jazz user with limited permissions
sudo useradd -m -s /bin/bash jazzuser

# Run Jazz as limited user
sudo -u jazzuser jazz agent chat my-agent
```

## 📚 Related Documentation

- **[Tools Reference](tools-reference.md)** - Detailed tool capabilities
- **[Getting Started](getting-started.md)** - Safe agent setup
- **[CLI Reference](cli-reference.md)** - Command options
- **[Integrations](integrations.md)** - API key management

## 🆘 Getting Help

**Security Questions:**

- Join [Discord](https://discord.gg/yBDbS2NZju)
- Open [GitHub Issue](https://github.com/lvndry/jazz/issues)
- Email security concerns to the maintainers

**Report Security Vulnerabilities:**

- See [SECURITY.md](../SECURITY.md) for responsible disclosure
- Do NOT post vulnerabilities in public issues

---

**Remember**: Jazz is a powerful tool. With great power comes great responsibility. Always review, always verify, always backup.

**The approval system is your safety net—use it wisely.**
