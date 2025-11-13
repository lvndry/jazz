# CLI Reference

Complete documentation for all Jazz CLI commands and options.

## 📋 Global Options

All commands support these global options:

```bash
jazz [global-options] <command> [command-options]
```

### Global Options

| Option            | Short | Description                | Default              |
| ----------------- | ----- | -------------------------- | -------------------- |
| `--verbose`       | `-v`  | Enable verbose logging     | `false`              |
| `--quiet`         | `-q`  | Suppress output            | `false`              |
| `--config <path>` |       | Path to configuration file | `./jazz.config.json` |
| `--help`          | `-h`  | Show help information      |                      |
| `--version`       | `-V`  | Show version information   |                      |

### Examples

```bash
# Enable verbose logging
jazz --verbose agent list

# Use custom config file
jazz --config /path/to/config.json agent create my-agent

# Suppress output
jazz --quiet agent delete <agent-id>
```

## 🤖 Agent Commands

Manage autonomous agents for automation tasks.

### `jazz agent list`

List all available agents.

```bash
jazz agent list
```

**Output:**

```
Found 2 agent(s):

1. my-agent (1724243d-344e-42ec-97e8-e53a2c8fd9d8)
   Description: My first automation agent
   Status: idle
   Tasks: 0
   Created: 2024-01-15T10:30:00.000Z
   Updated: 2024-01-15T10:30:00.000Z

2. backup-agent (3705b499-ff20-4c07-8b74-3728f049e889)
   Description: Automated backup agent
   Status: idle
   Tasks: 3
   Created: 2024-01-15T11:00:00.000Z
   Updated: 2024-01-15T11:00:00.000Z
```

### `jazz agent create`

Create a new agent with the specified name.

```bash
jazz agent create [options]
```

**Arguments:**

- `<name>` - Agent name (required, alphanumeric with hyphens/underscores)

**Options:**

| Option                        | Short | Description                   | Default            |
| ----------------------------- | ----- | ----------------------------- | ------------------ |
| `--description <description>` | `-d`  | Agent description             | `Agent for <name>` |
| `--timeout <timeout>`         | `-t`  | Agent timeout in milliseconds | `30000`            |
| `--max-retries <retries>`     | `-r`  | Maximum number of retries     | `3`                |
| `--retry-delay <delay>`       |       | Retry delay in milliseconds   | `1000`             |
| `--retry-backoff <backoff>`   |       | Retry backoff strategy        | `exponential`      |

**Backoff Strategies:**

- `linear` - Constant delay between retries
- `exponential` - Exponentially increasing delay
- `fixed` - Fixed delay for all retries

**Examples:**

```bash
# Create a basic agent
jazz agent create my-agent

# Create agent with custom description
jazz agent create backup-agent --description "Automated backup agent"

# Create agent with custom timeout and retry policy
jazz agent create api-agent \
  --description "API monitoring agent" \
  --timeout 60000 \
  --max-retries 5 \
  --retry-delay 2000 \
  --retry-backoff exponential
```

**Output:**

```
✅ Agent created successfully!
   ID: 1724243d-344e-42ec-97e8-e53a2c8fd9d8
   Name: my-agent
   Description: My first automation agent
   Status: idle
   Created: 2024-01-15T10:30:00.000Z
   Timeout: 30000ms
   Retry Policy: 3 retries, 1000ms delay, exponential backoff
```

### `jazz agent get <agent-id>`

Get detailed information about a specific agent.

```bash
jazz agent get <agent-id>
```

**Arguments:**

- `<agent-id>` - Agent UUID (required)

**Example:**

```bash
jazz agent get 1724243d-344e-42ec-97e8-e53a2c8fd9d8
```

**Output:**

```
📋 Agent Details:
   ID: 1724243d-344e-42ec-97e8-e53a2c8fd9d8
   Name: my-agent
   Description: My first automation agent
   Status: idle
   Created: 2024-01-15T10:30:00.000Z
   Updated: 2024-01-15T10:30:00.000Z

⚙️  Configuration:
   Timeout: 30000ms
   Tasks: 0
   Retry Policy:
     Max Retries: 3
     Delay: 1000ms
     Backoff: exponential

📝 No tasks configured for this agent.
```

### `jazz agent run <agent-id>`

Execute an agent and run its configured tasks.

```bash
jazz agent run <agent-id> [options]
```

**Arguments:**

- `<agent-id>` - Agent UUID (required)

**Options:**

| Option      | Description                                 | Default |
| ----------- | ------------------------------------------- | ------- |
| `--watch`   | Watch for changes and re-run                | `false` |
| `--dry-run` | Show what would be executed without running | `false` |

**Examples:**

```bash
# Run agent once
jazz agent run 1724243d-344e-42ec-97e8-e53a2c8fd9d8

# Dry run to see what would be executed
jazz agent run 1724243d-344e-42ec-97e8-e53a2c8fd9d8 --dry-run

# Watch mode for continuous execution
jazz agent run 1724243d-344e-42ec-97e8-e53a2c8fd9d8 --watch
```

**Output (Dry Run):**

```
🚀 Running agent: my-agent (1724243d-344e-42ec-97e8-e53a2c8fd9d8)
   Description: My first automation agent
   Status: idle
   Tasks: 2
   Mode: DRY RUN (no actual execution)

Tasks that would be executed:
   1. backup-database (command)
       Description: Backup the main database
   2. cleanup-logs (script)
       Description: Clean up old log files
       Dependencies: backup-database
```

**Output (Normal Run):**

```
🚀 Running agent: my-agent (1724243d-344e-42ec-97e8-e53a2c8fd9d8)
   Description: My first automation agent
   Status: running
   Tasks: 2

⚠️  Agent execution is not yet implemented.
   This is a placeholder for the execution engine.
   The agent has been validated and is ready for execution.
```

### `jazz agent chat <agent-id|agent-name>`

Start an interactive chat session with an AI agent. You can reference the agent either by its ID or by its unique name.

```bash
jazz agent chat <agent-id>
jazz agent chat <agent-name>
```

**Examples:**

```bash
# Start a chat using the agent ID
jazz agent chat 1724243d-344e-42ec-97e8-e53a2c8fd9d8

# Start a chat using the agent name
jazz agent chat my-agent
```

**Output:**

```
🤖 Starting chat with AI agent: my-agent (1724243d-344e-42ec-97e8-e53a2c8fd9d8)
   Description: My first automation agent

Type 'exit' or 'quit' to end the conversation.
Type '/help' to see available special commands.
```

### `jazz agent delete <agent-id>`

Delete an agent and all its associated data.

```bash
jazz agent delete <agent-id>
```

**Arguments:**

- `<agent-id>` - Agent UUID (required)

**Example:**

```bash
jazz agent delete 1724243d-344e-42ec-97e8-e53a2c8fd9d8
```

**Output:**

```
🗑️  Agent deleted successfully!
   Name: my-agent
   ID: 1724243d-344e-42ec-97e8-e53a2c8fd9d8
```

## 🔄 Automation Commands

Manage automation workflows and schedules.

### `jazz automation list`

List all available automations.

```bash
jazz automation list
```

**Status:** 🚧 Planned - Not yet implemented

### `jazz automation create`

Create a new automation workflow.

```bash
jazz automation create [options]
```

**Arguments:**

- `<name>` - Automation name (required)

**Options:**

| Option                        | Short | Description            | Default |
| ----------------------------- | ----- | ---------------------- | ------- |
| `--description <description>` | `-d`  | Automation description |         |

**Status:** 🚧 Planned - Not yet implemented

## ⚙️ Configuration Commands

Manage application configuration.

### `jazz config get <key>`

Get a configuration value.

```bash
jazz config get <key>
```

**Arguments:**

- `<key>` - Configuration key (required)

**Status:** 🚧 Planned - Not yet implemented

### `jazz config set <key> <value>`

Set a configuration value.

```bash
jazz config set <key> <value>
```

**Arguments:**

- `<key>` - Configuration key (required)
- `<value>` - Configuration value (required)

**Status:** 🚧 Planned - Not yet implemented

### `jazz config list`

List all configuration values.

```bash
jazz config list
```

**Status:** 🚧 Planned - Not yet implemented

## 📊 Logs Command

View and manage application logs.

### `jazz logs`

View application logs.

```bash
jazz logs [options]
```

**Options:**

| Option            | Short | Description         | Default |
| ----------------- | ----- | ------------------- | ------- |
| `--follow`        | `-f`  | Follow log output   | `false` |
| `--level <level>` | `-l`  | Filter by log level | `info`  |

**Log Levels:**

- `debug` - Detailed debugging information
- `info` - General information messages
- `warn` - Warning messages
- `error` - Error messages

**Examples:**

```bash
# View recent logs
jazz logs

# Follow logs in real-time
jazz logs --follow

# View only error logs
jazz logs --level error

# Follow debug logs
jazz logs --follow --level debug
```

**Status:** 🚧 Planned - Not yet implemented

## ❌ Error Handling

### Common Error Messages

#### Agent Not Found

```
❌ Agent with ID "invalid-id" not found
```

#### Storage Error

```
❌ Storage error: Failed to read file: ENOENT: no such file or directory
```

#### Validation Error

```
❌ Validation error: Agent name can only contain letters, numbers, underscores, and hyphens
```

#### Agent Already Exists

```
❌ Agent with name "existing-agent" already exists
```

#### Configuration Error

```
❌ Configuration error: Timeout must be between 1000ms and 3600000ms (1 hour)
```

### Exit Codes

| Code | Description               |
| ---- | ------------------------- |
| `0`  | Success                   |
| `1`  | General error             |
| `2`  | Invalid command or option |
| `3`  | Agent not found           |
| `4`  | Storage error             |
| `5`  | Validation error          |

## 🔧 Configuration File

Jazz supports configuration via a JSON file (planned feature):

```json
{
  "storage": {
    "type": "file",
    "path": "./.jazz"
  },
  "logging": {
    "level": "info",
    "format": "pretty",
    "output": "console"
  }
}
```

## 📝 Examples

### Complete Workflow Example

```bash
# 1. Create an agent
jazz agent create backup-agent \
  --description "Daily backup automation" \
  --timeout 300000 \
  --max-retries 3

# 2. List agents to verify creation
jazz agent list

# 3. Get agent details
jazz agent get <agent-id>

# 4. Run agent in dry-run mode
jazz agent run <agent-id> --dry-run

# 5. Run agent normally
jazz agent run <agent-id>

# 6. Delete agent when done
jazz agent delete <agent-id>
```

### Batch Operations

```bash
# Create multiple agents
jazz agent create web-scraper --description "Web scraping agent"
jazz agent create data-processor --description "Data processing agent"
jazz agent create report-generator --description "Report generation agent"

# List all agents
jazz agent list

# Run all agents (when batch execution is implemented)
jazz agent run-all
```

## 🚀 Advanced Usage

### Environment Variables

Override configuration using environment variables:

```bash
# Set custom storage path
export JAZZ_STORAGE_PATH="/custom/data/path"
jazz agent list

# Set log level
export JAZZ_LOG_LEVEL="debug"
jazz agent create my-agent

# Set timeout
export JAZZ_TIMEOUT="60000"
jazz agent run <agent-id>
```

### Scripting Integration

Use Jazz in shell scripts:

```bash
#!/bin/bash

# Create agent
AGENT_ID=$(jazz agent create backup-agent --description "Backup agent" | grep "ID:" | cut -d' ' -f3)

# Run agent
jazz agent run $AGENT_ID

# Check exit code
if [ $? -eq 0 ]; then
    echo "Backup completed successfully"
else
    echo "Backup failed"
    exit 1
fi
```

## 📚 Related Documentation

- [Architecture Overview](architecture.md) - System design and components
- [Agent Development](agent-development.md) - Creating and configuring agents
- [Configuration](configuration.md) - Configuration options and file format
- [Examples](examples.md) - Practical usage examples
