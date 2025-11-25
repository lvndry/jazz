# Security Guide

Jazz's security model: **trust-but-verify**. Agents are powerful, but you stay in control.

## Core Security Features

### 1. User Approval System

Dangerous operations always require explicit approval:

- Email deletion (trash or permanent)
- File creation/deletion
- Git commits and pushes
- Shell command execution

**Example:**

```
Agent: ⚠️ About to PERMANENTLY DELETE 127 emails. This cannot be undone!
Do you want me to proceed? (yes/no)
```

### 2. Command Filtering

40+ dangerous patterns are blocked automatically:

| Category                 | Examples               | Why Blocked                 |
| ------------------------ | ---------------------- | --------------------------- |
| **File Destruction**     | `rm -rf /`, `rm -rf ~` | Could delete entire systems |
| **Privilege Escalation** | `sudo`, `su`           | Could gain root access      |
| **Remote Execution**     | `curl ... \| sh`       | Could download malware      |
| **System Commands**      | `shutdown`, `reboot`   | Could shut down system      |

### 3. Environment Sanitization

Shell commands run with sanitized environment variables that exclude:

- API keys (vars containing "API", "KEY", "SECRET")
- Tokens (vars containing "TOKEN", "PASSWORD")
- Credentials (vars containing "CREDENTIAL", "AUTH")

**Implementation:** [`src/core/agent/tools/env-utils.ts`](../src/core/agent/tools/env-utils.ts)

### 4. Security Logging

All dangerous operations are logged to `~/.jazz/logs/` for audit purposes.

### 5. Timeout Protection

All operations have maximum execution times to prevent runaway processes:

- Shell commands: 30 seconds
- File operations: 10 seconds
- API requests: 30 seconds
- Git operations: 60 seconds

## Best Practices

### Creating Agents

**Principle of Least Privilege** - Only give tools the agent needs:

```bash
# Good - specific tools for specific purpose
jazz agent create email-helper --tools gmail

# Bad - unnecessary access
jazz agent create email-helper --tools gmail,git,shell,filesystem
```

### Using Agents

**Approval Checklist:**

```
Before approving:
□ Do I understand what this will do?
□ Am I in the right directory?
□ Are the file paths correct?
□ Is this reversible if something goes wrong?
□ Do I have backups if needed?
```

### Gmail Operations

1. **Start small** - Test with a few emails before bulk operations
2. **Use trash first** - Trash emails before permanent deletion
3. **Verify counts** - Check email counts before approving deletion

### File Operations

1. **Check pwd first** - Know your working directory
2. **Use absolute paths** - Avoid ambiguity
3. **Test with ls** - List contents before operations
4. **Backup before deletion** - Copy important files first

### Git Operations

1. **Check status first** - Run `git status` before commits
2. **Review diffs** - See what's changed
3. **Verify remote** - Check remote before pushing
4. **Never force push to main** - Protect important branches

### Shell Commands

**Safe:**

```bash
npm install
git status
ls -la
cat package.json
```

**Risky (be careful):**

```bash
rm -rf node_modules  # Could delete wrong folder
npm install -g       # Installs globally
chmod 777 *          # Too permissive
```

## If Something Goes Wrong

1. **Stop immediately** - Exit the agent (`exit`)
2. **Assess damage** - Check what was affected
3. **Review logs** - `~/.jazz/logs/`
4. **Restore from backup** - If data was lost

### Recovery

**Deleted files:** Check trash/recycle bin, restore from backup

**Git issues:**

```bash
git reflog  # Find previous state
git reset --hard <commit>  # Restore
```

**Email issues:** Check Gmail trash (30-day retention)

## Security Checklist

```
□ Agents have minimum required tools
□ Approval system is working
□ Logs are being captured
□ Backups are current
□ API keys are secure
□ Jazz is up to date
```

## Advanced Security

### Container Isolation

Run Jazz in Docker for additional isolation:

```dockerfile
FROM node:18-alpine
RUN npm install -g jazz-ai
USER node
WORKDIR /home/node
CMD ["jazz"]
```

### Separate Accounts

Use dedicated accounts for automation:

- Separate Gmail account for email operations
- Separate GitHub account for bot operations
- Dedicated user account for running Jazz

## Getting Help

**Security Questions:**

- [Discord](https://discord.gg/yBDbS2NZju)
- [GitHub Issues](https://github.com/lvndry/jazz/issues)

**Report Security Vulnerabilities:**

- See [SECURITY.md](../SECURITY.md) for responsible disclosure
- Do NOT post vulnerabilities in public issues

---

**Remember**: The approval system is your safety net. Always review, always verify, always backup.
