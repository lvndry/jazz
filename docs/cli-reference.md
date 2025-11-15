# CLI Reference

Complete reference for all Jazz CLI commands.

## Global Options

Available for all commands:

```bash
jazz [options] <command> [args]
```

| Option            | Short | Description                |
| ----------------- | ----- | -------------------------- |
| `--verbose`       | `-v`  | Enable verbose logging     |
| `--debug`         |       | Enable debug-level logging |
| `--config <path>` |       | Use custom config file     |
| `--help`          | `-h`  | Show help                  |
| `--version`       |       | Show version               |

**Examples:**

```bash
# Verbose output
jazz --verbose agent list

# Debug mode
jazz --debug agent chat my-agent

# Custom config
jazz --config /path/to/config.json agent create
```

---

## Agent Commands

Manage AI agents for automation.

### `jazz agent create`

Create a new agent interactively.

```bash
jazz agent create
```

**Interactive prompts:**

1. Agent name
2. Description
3. Agent type (default/gmail)
4. LLM provider
5. LLM model
6. Tool categories

**Example session:**

```
$ jazz agent create

🤖 Welcome to the Jazz AI Agent Creation Wizard!

? What would you like to name your AI agent? email-helper
? Describe what this AI agent will do: Manage my Gmail inbox
? What type of agent would you like to create? default
? Which LLM provider would you like to use? openai
? Which model would you like to use? gpt-4o-mini
? Which tools should this agent have access to? Gmail (16 tools)

✅ AI Agent created successfully!
   ID: 550e8400-e29b-41d4-a716-446655440000
   Name: email-helper
   ...
```

---

### `jazz agent list`

List all agents.

```bash
jazz agent list [options]
```

**Options:** | Option | Description | |--------|-------------| | `--verbose` | Show detailed
information |

**Output:**

```
Found 3 agent(s):

1. email-helper (550e8400-e29b-41d4-a716-446655440000)
   Description: Manage my Gmail inbox
   LLM: openai/gpt-4o-mini
   Created: 2025-01-15T10:30:00.000Z
   Updated: 2025-01-15T10:30:00.000Z

2. git-assistant (661f9510-f39c-52e5-b827-557766551111)
   Description: Help with git operations
   LLM: anthropic/claude-3-5-sonnet-20251022
   Created: 2025-01-15T11:00:00.000Z
   Updated: 2025-01-15T11:00:00.000Z
```

---

### `jazz agent chat <agentRef>`

Start a conversation with an agent.

```bash
jazz agent chat <id|name>
```

**Arguments:**

- `agentRef`: Agent ID or name

**Examples:**

```bash
# By name
jazz agent chat email-helper

# By ID
jazz agent chat 550e8400-e29b-41d4-a716-446655440000
```

**Chat commands:**

While chatting, use these special commands:

| Command          | Description                            |
| ---------------- | -------------------------------------- |
| `/new`           | Start new conversation (clear context) |
| `/status`        | Show conversation status               |
| `/tools`         | List available tools                   |
| `/clear`         | Clear screen                           |
| `/help`          | Show help                              |
| `exit` or `quit` | End conversation                       |

**Example conversation:**

```
🤖 Starting chat with AI agent: email-helper (550e...)

Type 'exit' or 'quit' to end the conversation.
Type '/help' to see available special commands.

You: Show me unread emails from today

Agent: [Uses search_emails tool]
       I found 12 unread emails from today...

You: exit
👋 Goodbye!
```

---

### `jazz agent get <agentId>`

View agent details.

```bash
jazz agent get <id>
```

**Output:**

```
📋 Agent Details:
   ID: 550e8400-e29b-41d4-a716-446655440000
   Name: email-helper
   Description: Manage my Gmail inbox
   Status: idle
   Created: 2025-01-15T10:30:00.000Z
   Updated: 2025-01-15T10:30:00.000Z

⚙️  Configuration:
   Agent Type: default
   LLM Provider: openai
   LLM Model: gpt-4o-mini
   Reasoning Effort: low
   Tools (16):
     Gmail: list_emails, get_email, search_emails, send_email, ...
```

---

### `jazz agent edit <agentId>`

Edit an existing agent interactively.

```bash
jazz agent edit <id>
```

**What you can edit:**

- Name
- Description
- Status
- Agent type
- LLM provider and model
- Tools
- Timeout
- Retry policy

**Example:**

```
$ jazz agent edit 550e8400-e29b-41d4-a716-446655440000

✏️  Welcome to the Jazz Agent Edit Wizard!

📋 Current Agent: email-helper
   ID: 550e8400-e29b-41d4-a716-446655440000
   Description: Manage my Gmail inbox
   Tools: 16 tools

? What would you like to update?
  ◉ Name
  ◯ Description
  ◯ LLM Provider
  ◯ Tools
```

---

### `jazz agent delete <agentId>`

Delete an agent.

```bash
jazz agent delete <id>
```

**Example:**

```
$ jazz agent delete 550e8400-e29b-41d4-a716-446655440000

🗑️  Agent deleted successfully!
   Name: email-helper
   ID: 550e8400-e29b-41d4-a716-446655440000
```

---

## Authentication Commands

Manage service authentication.

### Gmail Authentication

#### `jazz auth gmail login`

Authenticate with Gmail via OAuth.

```bash
jazz auth gmail login
```

**Process:**

1. Opens browser for Google OAuth
2. User grants permissions
3. Redirects to localhost callback
4. Stores tokens securely

**Required config:**

```json
{
  "google": {
    "clientId": "your-client-id.apps.googleusercontent.com",
    "clientSecret": "your-client-secret"
  }
}
```

---

#### `jazz auth gmail status`

Check Gmail authentication status.

```bash
jazz auth gmail status
```

**Output:**

```
✅ Gmail Authentication Status: Connected
   Email: your.email@gmail.com
   Scopes: gmail.modify, gmail.compose, gmail.labels
   Token expires: 2025-01-16T10:30:00.000Z
```

or

```
❌ Gmail Authentication Status: Not connected
   Run 'jazz auth gmail login' to authenticate
```

---

#### `jazz auth gmail logout`

Logout from Gmail.

```bash
jazz auth gmail logout
```

**Output:**

```
✅ Successfully logged out from Gmail
   Tokens have been removed
```

---

## Quick Reference

### Common Workflows

**Create and use an agent:**

```bash
# 1. Create agent
jazz agent create

# 2. Chat with agent
jazz agent chat my-agent

# 3. List agents
jazz agent list

# 4. Delete agent
jazz agent delete <id>
```

**Gmail setup:**

```bash
# 1. Configure in config.json
# 2. Authenticate
jazz auth gmail login

# 3. Check status
jazz auth gmail status

# 4. Create Gmail agent
jazz agent create
# Select Gmail tools
```

**Debug issues:**

```bash
# Run with debug output
jazz --debug agent chat my-agent

# Run with verbose logging
jazz --verbose agent list

# Check version
jazz --version
```

---

## Exit Codes

| Code | Meaning              |
| ---- | -------------------- |
| 0    | Success              |
| 1    | General error        |
| 2    | Configuration error  |
| 3    | Authentication error |
| 4    | Network error        |
| 5    | Storage error        |

---

## Configuration File Location

Jazz looks for configuration in order:

1. `JAZZ_CONFIG_PATH` environment variable
2. `./jazz.config.json` (current directory)
3. `~/.jazz/config.json` (home directory)

**Specify custom location:**

```bash
export JAZZ_CONFIG_PATH=/path/to/config.json
# or
jazz --config /path/to/config.json <command>
```

---

## Environment Variables

Override configuration with environment variables:

```bash
# LLM Provider API Keys
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GOOGLE_GENERATIVE_AI_API_KEY="AIza..."

# Configuration
export JAZZ_CONFIG_PATH="/path/to/config.json"

# Linkup
export LINKUP_API_KEY="your-key"
```

---

## Troubleshooting

### "No LLM providers configured"

**Solution:** Add API key to config:

```json
{
  "llm": {
    "openai": {
      "api_key": "sk-..."
    }
  }
}
```

### "Agent not found"

**Possible causes:**

- Wrong agent ID
- Agent deleted
- Wrong config file location

**Solution:**

```bash
# List all agents
jazz agent list

# Use correct ID or name
jazz agent chat <correct-id-or-name>
```

### "Gmail authentication required"

**Solution:**

```bash
# Authenticate
jazz auth gmail login

# Verify
jazz auth gmail status
```

### "Command execution failed"

**Solution:**

```bash
# Check with debug mode
jazz --debug agent chat my-agent

# Verify API keys are valid
# Check network connection
```
