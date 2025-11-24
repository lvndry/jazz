# Tools Reference

Complete reference for all tools available to Jazz agents.

## Overview

Jazz provides 44 tools across 6 categories that enable agents to interact with various systems and services. All tools follow a consistent pattern with validation, error handling, and approval workflows where needed.

## Tool Categories

| Category            | Count | Approval Required   | Description                     |
| ------------------- | ----- | ------------------- | ------------------------------- |
| **Gmail**           | 16    | For destructive ops | Email management and automation |
| **Git**             | 9     | For write ops       | Version control operations      |
| **File Management** | 15    | For write ops       | File system operations          |
| **Shell**           | 2     | Always              | Command execution               |
| **Web Search**      | 1     | No                  | Internet search via Linkup      |
| **HTTP**            | 1     | No                  | API requests                    |

---

## 📧 Gmail Tools (16 tools)

Enable agents to manage Gmail with comprehensive email operations including reading, searching, labeling, composing, and managing emails.

**Tool definitions:** [`src/core/agent/tools/gmail-tools.ts`](../src/core/agent/tools/gmail-tools.ts)

---

## 🔧 Git Tools (9 tools)

Enable version control operations with safety approvals for write operations. All commands invoke the native `git` CLI with paging disabled so output returns inline, ready for the agent to read or summarize.

**Tool definitions:** [`src/core/agent/tools/git-tools.ts`](../src/core/agent/tools/git-tools.ts)

---

## 📁 File Management Tools (15 tools)

File system operations with context-aware working directory including navigation, reading, searching, and writing files.

**Tool definitions:** [`src/core/agent/tools/fs-tools.ts`](../src/core/agent/tools/fs-tools.ts)

---

## 💻 Shell Tools (2 tools)

Execute shell commands with comprehensive security checks. Blocks dangerous patterns (rm -rf, sudo, curl|sh, etc.) and logs all executions for audit.

**Tool definitions:** [`src/core/agent/tools/shell-tools.ts`](../src/core/agent/tools/shell-tools.ts)

---

## 🌐 Web Search Tools (1 tool)

Search the internet for current information via Linkup or Exa with standard (fast) or deep (comprehensive) search modes.

**Tool definitions:** [`src/core/agent/tools/web-search-tools.ts`](../src/core/agent/tools/web-search-tools.ts)

---

## 🔗 HTTP Tools (1 tool)

Make HTTP requests to APIs and web services with automatic JSON parsing, error handling, retries, and timeout protection.

**Tool definitions:** [`src/core/agent/tools/http-tools.ts`](../src/core/agent/tools/http-tools.ts)

---

## Tool Selection Best Practices

### For Agents

Agents automatically select appropriate tools based on user requests using:

1. **Natural Language Understanding**: Parse user intent
2. **Tool Discovery**: Find matching tools by tags and descriptions
3. **Parameter Extraction**: Extract values from context
4. **Approval Awareness**: Warn about operations requiring approval
5. **Error Recovery**: Retry with different tools if needed

### For Users

To get best results:

1. **Be Specific**: "Show unread emails from today" vs "check email"
2. **Provide Context**: File paths, email addresses, time ranges
3. **Review Approvals**: Always read approval messages carefully
4. **Chain Operations**: "Search emails, label them, then archive"

## Security Considerations

### Approval System

Tools requiring approval use a two-phase system:

**Phase 1: Request**

- Agent calls approval tool (e.g., `delete_email`)
- Tool shows detailed approval message
- Returns approval request to user

**Phase 2: Execute**

- User approves
- Agent calls execution tool (e.g., `execute_delete_email`)
- Tool performs actual operation

### Security Features

1. **Command Filtering**: Shell commands checked against 40+ dangerous patterns
2. **Path Validation**: File paths validated to prevent traversal attacks
3. **Environment Sanitization**: Sensitive variables removed from shell execution
4. **Audit Logging**: All command executions logged with timestamps
5. **Timeout Protection**: All operations have maximum execution time

### Best Practices

1. **Always Review Approvals**: Never blindly approve operations
2. **Understand Context**: Know your current working directory
3. **Use Specific Paths**: Prefer absolute paths for critical operations
4. **Check Before Delete**: Verify file/email counts before approving deletion
5. **Monitor Logs**: Review command execution logs regularly

---

**Need help with tools?** Join our [Discord](https://discord.gg/yBDbS2NZju) or check [GitHub Issues](https://github.com/lvndry/jazz/issues)
