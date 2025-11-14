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

Enable agents to manage Gmail with comprehensive email operations.

### Read Operations (No Approval)

#### `listEmails`

List emails with optional filtering.

**Parameters:**

- `maxResults` (optional): Maximum emails to return (1-100, default: 10)
- `query` (optional): Gmail search query (e.g., "in:inbox newer_than:7d")

**Example:**

```
"List my last 20 emails"
→ listEmails({ maxResults: 20 })
```

#### `getEmail`

Get full content of a specific email.

**Parameters:**

- `emailId` (required): ID of the email to retrieve

**Example:**

```
"Show me the full content of email abc123"
→ getEmail({ emailId: "abc123" })
```

#### `searchEmails`

Search emails matching criteria.

**Parameters:**

- `query` (required): Gmail search query
- `maxResults` (optional): Maximum results (1-100, default: 10)

**Example:**

```
"Find emails from GitHub in the last week"
→ searchEmails({ query: "from:github.com newer_than:7d", maxResults: 20 })
```

#### `listLabels`

List all Gmail labels (system and custom).

**Parameters:** None

**Example:**

```
"What labels do I have?"
→ listLabels({})
```

### Label Management (No Approval)

#### `createLabel`

Create a new Gmail label.

**Parameters:**

- `name` (required): Label name
- `labelListVisibility` (optional): "labelShow" or "labelHide"
- `messageListVisibility` (optional): "show" or "hide"
- `color` (optional): { textColor, backgroundColor } with Gmail color codes

**Example:**

```
"Create a label called 'important-project'"
→ createLabel({ name: "important-project" })
```

#### `updateLabel`

Update existing label properties.

**Parameters:**

- `labelId` (required): ID of label to update
- `name` (optional): New name
- `labelListVisibility` (optional): Visibility setting
- `messageListVisibility` (optional): Visibility setting
- `color` (optional): New colors

#### `deleteLabel` (Requires Approval)

Delete a user-created label.

**Parameters:**

- `labelId` (required): ID of label to delete

**Approval:** Shows label details and confirms permanent deletion.

#### `addLabelsToEmail`

Add labels to an email.

**Parameters:**

- `emailId` (required): Email ID
- `labelIds` (required): Array of label IDs to add

**Example:**

```
"Add 'dev' and 'urgent' labels to email abc123"
→ addLabelsToEmail({ emailId: "abc123", labelIds: ["Label_1", "Label_2"] })
```

#### `removeLabelsFromEmail`

Remove labels from an email.

**Parameters:**

- `emailId` (required): Email ID
- `labelIds` (required): Array of label IDs to remove

#### `batchModifyEmails`

Modify multiple emails at once.

**Parameters:**

- `emailIds` (required): Array of email IDs (max 1000)
- `addLabelIds` (optional): Labels to add
- `removeLabelIds` (optional): Labels to remove

**Example:**

```
"Archive all emails from the last search"
→ batchModifyEmails({ emailIds: [...], removeLabelIds: ["INBOX"] })
```

### Compose & Send (No Approval)

#### `sendEmail`

Create a draft email (doesn't send immediately).

**Parameters:**

- `to` (required): Array of recipient emails
- `subject` (required): Email subject
- `body` (required): Email body (plain text)
- `cc` (optional): CC recipients
- `bcc` (optional): BCC recipients

**Example:**

```
"Draft an email to john@example.com about the meeting"
→ sendEmail({
  to: ["john@example.com"],
  subject: "Meeting Follow-up",
  body: "Hi John, ..."
})
```

### Destructive Operations (Require Approval)

#### `trashEmail` (Requires Approval)

Move email to trash (recoverable).

**Parameters:**

- `emailId` (required): Email ID

**Approval:** Shows email preview with subject, sender, date, and confirms trash action.

#### `deleteEmail` (Requires Approval)

Permanently delete email (not recoverable).

**Parameters:**

- `emailId` (required): Email ID

**Approval:** Shows email preview and warns about permanent deletion.

---

## 🔧 Git Tools (9 tools)

Enable version control operations with safety approvals for write operations.

### Read Operations (No Approval)

#### `gitStatus`

Show working tree status.

**Parameters:**

- `path` (optional): Repository path (defaults to cwd)

**Example:**

```
"What's changed in my repo?"
→ gitStatus({})
```

#### `gitLog`

Show commit history.

**Parameters:**

- `path` (optional): Repository path
- `limit` (optional): Number of commits (1-100)
- `oneline` (optional): Compact one-line format

**Example:**

```
"Show me the last 10 commits"
→ gitLog({ limit: 10 })
```

#### `gitDiff`

Show changes between commits, branches, or working tree.

**Parameters:**

- `path` (optional): Repository path
- `staged` (optional): Show staged changes
- `branch` (optional): Compare with branch
- `commit` (optional): Compare with commit

**Example:**

```
"What's different from main?"
→ gitDiff({ branch: "main" })
```

#### `gitBranch`

List, create, or manage branches.

**Parameters:**

- `path` (optional): Repository path
- `list` (optional): List branches (default: true)
- `all` (optional): Show remote branches
- `remote` (optional): Show only remote branches

**Example:**

```
"List all branches"
→ gitBranch({ list: true, all: true })
```

### Write Operations (Require Approval)

#### `gitAdd` (Requires Approval)

Stage files for commit.

**Parameters:**

- `path` (optional): Repository path
- `files` (required): Array of file paths to add
- `all` (optional): Stage all changes

**Approval:** Shows files to be staged and working directory.

#### `gitCommit` (Requires Approval)

Record changes to repository.

**Parameters:**

- `path` (optional): Repository path
- `message` (required): Commit message
- `all` (optional): Commit all tracked changes

**Approval:** Shows commit message and working directory.

#### `gitPush` (Requires Approval)

Push commits to remote.

**Parameters:**

- `path` (optional): Repository path
- `remote` (optional): Remote name (default: "origin")
- `branch` (optional): Branch name
- `force` (optional): Force push (dangerous!)

**Approval:** Shows remote, branch, and warns about force push if enabled.

#### `gitPull` (Requires Approval)

Fetch and integrate from remote.

**Parameters:**

- `path` (optional): Repository path
- `remote` (optional): Remote name (default: "origin")
- `branch` (optional): Branch name
- `rebase` (optional): Use rebase instead of merge

**Approval:** Shows remote, branch, and rebase status.

#### `gitCheckout` (Requires Approval)

Switch branches or restore files.

**Parameters:**

- `path` (optional): Repository path
- `branch` (required): Branch name to checkout
- `create` (optional): Create branch if it doesn't exist
- `force` (optional): Force checkout (discards local changes)

**Approval:** Shows branch name, creation status, and warns about force checkout.

---

## 📁 File Management Tools (15 tools)

File system operations with context-aware working directory.

### Navigation (No Approval)

#### `pwd`

Print working directory.

**Parameters:** None

**Example:**

```
"Where am I?"
→ pwd({})
```

#### `cd`

Change directory.

**Parameters:**

- `path` (required): Directory path (absolute or relative)

**Example:**

```
"Go to my Documents folder"
→ cd({ path: "~/Documents" })
```

#### `ls`

List directory contents.

**Parameters:**

- `path` (optional): Directory to list (defaults to cwd)
- `all` (optional): Show hidden files
- `long` (optional): Long format with details

**Example:**

```
"List all files including hidden ones"
→ ls({ all: true })
```

### Read Operations (No Approval)

#### `readFile`

Read file contents.

**Parameters:**

- `path` (required): File path
- `encoding` (optional): Text encoding (default: utf-8)

**Example:**

```
"Show me the contents of package.json"
→ readFile({ path: "package.json" })
```

#### `stat`

Get file or directory information.

**Parameters:**

- `path` (required): File or directory path

**Returns:** Size, type, permissions, timestamps

#### `grep`

Search file contents for pattern.

**Parameters:**

- `pattern` (required): Search pattern (regex)
- `path` (optional): File or directory (defaults to cwd)
- `recursive` (optional): Search subdirectories
- `ignoreCase` (optional): Case-insensitive search

**Example:**

```
"Find all TODO comments in source files"
→ grep({ pattern: "TODO", path: "src", recursive: true })
```

#### `find`

Find files by name or type.

**Parameters:**

- `name` (optional): File name pattern
- `path` (optional): Starting directory
- `type` (optional): "file", "dir", or "all"
- `maxResults` (optional): Limit results (default: 5000)
- `maxDepth` (optional): Max directory depth (default: 25)
- `includeHidden` (optional): Include hidden files

**Example:**

```
"Find all TypeScript files"
→ find({ name: "*.ts", type: "file" })
```

#### `findDir`

Find directories by name.

**Parameters:**

- `name` (required): Directory name pattern
- `path` (optional): Starting directory
- `maxResults` (optional): Limit results

#### `findPath`

Find files or directories by exact name.

**Parameters:**

- `name` (required): Exact name to find
- `path` (optional): Starting directory

### Write Operations (Require Approval)

#### `mkdir` (Requires Approval)

Create directory.

**Parameters:**

- `path` (required): Directory path to create
- `recursive` (optional): Create parent directories

**Approval:** Shows directory path to be created.

#### `writeFile` (Requires Approval)

Write content to file.

**Parameters:**

- `path` (required): File path
- `content` (required): Content to write
- `encoding` (optional): Text encoding
- `createDirs` (optional): Create parent directories

**Approval:** Shows file path, size, and whether it will overwrite existing file.

#### `rm` (Requires Approval)

Remove files or directories.

**Parameters:**

- `path` (required): Path to remove
- `recursive` (optional): Remove directories recursively
- `force` (optional): Force removal

**Approval:** Shows path, type (file/directory), and warns about permanent deletion.

---

## 💻 Shell Tools (2 tools)

Execute shell commands with comprehensive security checks.

#### `executeCommand` (Requires Approval)

Execute a shell command.

**Parameters:**

- `command` (required): Shell command to execute
- `workingDirectory` (optional): Working directory
- `timeout` (optional): Timeout in milliseconds (default: 30000)

**Security:**

- Blocks dangerous patterns (rm -rf, sudo, curl|sh, etc.)
- Sanitizes environment variables
- Logs all executions for audit
- Runs with current user privileges

**Approval:** Shows full command details, working directory, and timeout.

**Example:**

```
"Install npm dependencies"
→ executeCommand({ command: "npm install" })
```

**Blocked Commands:**

- `rm -rf /` - File system destruction
- `sudo` - Privilege escalation
- `curl ... | sh` - Remote code execution
- And 40+ other dangerous patterns

---

## 🌐 Web Search Tools (1 tool)

Search the internet for current information.

#### `web_search`

Search the web via Linkup.

**Parameters:**

- `query` (required): Search query
- `depth` (optional): "standard" or "deep" (default: "standard")
- `outputType` (optional): "sourcedAnswer", "searchResults", or "structured"
- `includeImages` (optional): Include images in results

**Search Modes:**

- **Standard**: Fast results (1-2 seconds), 3-5 sources
- **Deep**: Comprehensive research (5-10 seconds), 10+ sources

**Output Types:**

- **sourcedAnswer**: AI-friendly format with answer and sources
- **searchResults**: Raw search results
- **structured**: Structured data format

**Example:**

```
"Search for TypeScript 5.5 new features"
→ web_search({
  query: "TypeScript 5.5 new features",
  depth: "deep",
  outputType: "sourcedAnswer"
})
```

**Requires:** Linkup API key in config

---

## 🔗 HTTP Tools (1 tool)

Make HTTP requests to APIs and web services.

#### `httpRequest`

Make an HTTP request.

**Parameters:**

- `url` (required): Request URL
- `method` (optional): GET, POST, PUT, DELETE, PATCH (default: GET)
- `headers` (optional): Request headers
- `body` (optional): Request body
- `timeout` (optional): Request timeout in ms

**Example:**

```
"Get data from the API"
→ httpRequest({
  url: "https://api.example.com/data",
  method: "GET",
  headers: { "Authorization": "Bearer token" }
})
```

**Features:**

- Automatic JSON parsing
- Error handling with retries
- Timeout protection
- Response validation

---

## Tool Execution Flow

### 1. Request Phase

Agent decides to use a tool based on user request.

### 2. Validation Phase

Tool parameters are validated:

- Required parameters present
- Types correct
- Values within allowed ranges

### 3. Approval Phase (if required)

For dangerous operations:

- Agent shows approval message with details
- User reviews and approves/rejects
- Agent proceeds only after approval

### 4. Execution Phase

Tool executes with:

- Error handling
- Timeout protection
- Result collection

### 5. Response Phase

Agent receives result and:

- Presents to user
- Uses for next steps
- Handles errors gracefully

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

- Agent calls approval tool (e.g., `deleteEmail`)
- Tool shows detailed approval message
- Returns approval request to user

**Phase 2: Execute**

- User approves
- Agent calls execution tool (e.g., `executeDeleteEmail`)
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

## Tool Categories Deep Dive

### When to Use Gmail Tools

- Email triage and organization
- Automated responses
- Label management
- Bulk email operations
- Email search and analysis

### When to Use Git Tools

- Version control workflows
- Code review preparation
- Branch management
- Commit history analysis
- Remote synchronization

### When to Use File Tools

- File system navigation
- Code search and analysis
- File organization
- Backup operations
- Content management

### When to Use Shell Tools

- Package installations
- Build operations
- System maintenance
- Custom scripts
- Development workflows

### When to Use Web Search

- Current information lookup
- Research tasks
- Fact verification
- Technology learning
- Market research

### When to Use HTTP Tools

- API integration
- Webhook handling
- Data fetching
- Service monitoring
- Third-party integrations

---

## Related Documentation

- **[Getting Started](getting-started.md)** - Create your first agent
- **[Integrations](integrations.md)** - Set up Gmail and Linkup
- **[CLI Reference](cli-reference.md)** - Command-line interface
- **[Security](security.md)** - Security best practices

---

**Need help with tools?** Join our [Discord](https://discord.gg/yBDbS2NZju) or check [GitHub Issues](https://github.com/lvndry/jazz/issues)
