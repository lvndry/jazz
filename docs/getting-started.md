# Getting Started with Jazz

This guide will help you get up and running with Jazz in minutes.

## Prerequisites

Before you begin, ensure you have:

- Node.js 18 or higher installed
- npm, bun, pnpm, or yarn package manager
- A terminal or command-line interface

## Installation

Install Jazz globally using your preferred package manager:

```bash
# Using npm
npm install -g jazz-ai

# Using bun
bun add -g jazz-ai

# Using pnpm
pnpm add -g jazz-ai

# Using yarn
yarn global add jazz-ai
```

Verify the installation:

```bash
jazz --version
```

## Initial Configuration

### 1. Set Up LLM Provider

Jazz needs at least one LLM provider configured. Create a configuration file at `~/.jazz/config.json`:

```json
{
  "llm": {
    "openai": {
      "api_key": "sk-..."
    }
  }
}
```

**Get API Keys:**

- **OpenAI**: [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- **Anthropic**: [console.anthropic.com](https://console.anthropic.com/)
- **Google**: [makersuite.google.com/app/apikey](https://makersuite.google.com/app/apikey)

See [integrations.md](integrations.md) for detailed setup instructions for all providers.

### 2. Optional: Configure Gmail (for email tools)

If you want your agents to manage Gmail:

1. Follow the [Gmail Integration](integrations.md#gmail-integration) guide
2. Run `jazz auth gmail login`
3. Complete the OAuth flow in your browser

### 3. Optional: Configure Linkup (for web search)

If you want your agents to search the web:

1. Get an API key from [linkup.so](https://www.linkup.so/)
2. Add to your config:

```json
{
  "linkup": {
    "api_key": "your-linkup-api-key"
  }
}
```

## Create Your First Agent

### Interactive Creation

Run the agent creation wizard:

```bash
jazz agent create
```

You'll be prompted for:

1. **Name**: Give your agent a descriptive name (e.g., "email-helper", "git-assistant")
2. **Description**: What will this agent do? (e.g., "Help manage my Gmail inbox")
3. **Agent Type**: Choose "default" for general purpose
4. **LLM Provider**: Select from your configured providers
5. **LLM Model**: Choose a model (GPT-4o, Claude 3.5 Sonnet, etc.)
6. **Tools**: Select tool categories:
   - **Gmail** - Email management (16 tools)
   - **Git** - Version control (9 tools)
   - **File Management** - File operations (15 tools)
   - **Shell** - Command execution (2 tools)
   - **Web Search** - Internet search (1 tool)
   - **HTTP** - API requests (1 tool)

**Example Session:**

```
🤖 Welcome to the Jazz AI Agent Creation Wizard!

? What would you like to name your AI agent? email-assistant
? Describe what this AI agent will do: Help me manage my Gmail inbox
? What type of agent would you like to create? default
? Which LLM provider would you like to use? openai
? Which model would you like to use? gpt-4o-mini
? Which tools should this agent have access to? Gmail (16 tools)

✅ AI Agent created successfully!
   ID: 550e8400-e29b-41d4-a716-446655440000
   Name: email-assistant
   Description: Help me manage my Gmail inbox
   Type: default
   LLM Provider: openai
   LLM Model: gpt-4o-mini
   Tool Categories: Gmail
   Total Tools: 16
   Status: idle
   Created: 2025-01-15T10:30:00.000Z

You can now chat with your agent using:
   • By ID:   jazz agent chat 550e8400-e29b-41d4-a716-446655440000
   • By name: jazz agent chat email-assistant
```

## Start Chatting

Start a conversation with your agent:

```bash
# By name
jazz agent chat email-assistant

# Or by ID
jazz agent chat 550e8400-e29b-41d4-a716-446655440000
```

### Example Conversation - Email Management

```
🤖 Starting chat with AI agent: email-assistant (550e...)
   Description: Help me manage my Gmail inbox

Type 'exit' or 'quit' to end the conversation.
Type '/help' to see available special commands.

You: Show me my unread emails from today

Agent: Let me search for your unread emails from today.

[Agent uses searchEmails tool]

I found 12 unread emails from today. Here are the highlights:

1. **GitHub Notifications** (5 emails)
   - Pull request reviews
   - Issue mentions

2. **Team Updates** (3 emails)
   - Sprint planning from Sarah
   - Weekly report from manager

3. **Newsletters** (4 emails)
   - JavaScript Weekly
   - Node Weekly

Would you like me to help you organize these?

You: Label the GitHub ones as "dev" and archive them

Agent: 🔍 About to add label "dev" to 5 emails and archive them.

Would you like me to proceed? (yes/no)

You: yes

Agent: ✓ Done! I've:
   - Added "dev" label to 5 GitHub emails
   - Archived all 5 emails

Your inbox is now cleaner! Anything else?
```

### Example Conversation - Git Operations

First, create a Git assistant:

```bash
jazz agent create

# Configure with:
# - Name: git-helper
# - Description: Help with git operations
# - Tools: Git
```

Then chat:

```
You: What's the status of my repository?

Agent: [Runs git status]

Your repository has the following changes:

**Modified files:**
- src/services/config.ts
- README.md

**Untracked files:**
- docs/getting-started.md

Would you like me to help you commit these changes?

You: Yes, write a good commit message

Agent: [Analyzes the changes]

Based on the changes, I suggest:

"docs: add getting started guide and update config service"

This follows conventional commits format. Should I proceed with this message?

You: yes

Agent: [Requests approval]

⚠️ About to stage and commit:
- 3 files
- Commit message: "docs: add getting started guide and update config service"

Proceed? (yes/no)

You: yes

Agent: ✓ Changes committed!
   Commit hash: abc123f

Would you like me to push to remote?
```

## Special Commands

While chatting with an agent, you can use these commands:

- `/new` - Start a new conversation (clear context)
- `/status` - Show conversation status
- `/tools` - List available tools
- `/clear` - Clear the screen
- `/help` - Show help message
- `exit` or `quit` - End the conversation

## Managing Agents

### List All Agents

```bash
jazz agent list

# With detailed info
jazz agent list --verbose
```

### View Agent Details

```bash
jazz agent get <agent-id>
```

### Edit an Agent

```bash
jazz agent edit <agent-id>
```

This opens an interactive wizard to modify:

- Name
- Description
- Status
- LLM provider and model
- Tools
- Timeout and retry settings

### Delete an Agent

```bash
jazz agent delete <agent-id>
```

## Understanding Tool Categories

Jazz provides tools organized by category:

| Category            | Tools | What Can Agents Do?                                                                                   |
| ------------------- | ----- | ----------------------------------------------------------------------------------------------------- |
| **Gmail**           | 16    | List, search, read, send, label management, batch operations, delete (with approval)                  |
| **Git**             | 9     | Status, log, diff, branch, add, commit, push, pull, checkout (write operations require approval)      |
| **File Management** | 15    | Navigate (pwd, cd, ls), read files, write files (approval), search (grep, find), mkdir, rm (approval) |
| **Shell**           | 2     | Execute commands with security validation and approval                                                |
| **Web Search**      | 1     | Search the web via Linkup (standard and deep search modes)                                            |
| **HTTP**            | 1     | Make HTTP requests to APIs                                                                            |

See [tools-reference.md](tools-reference.md) for detailed documentation of each tool.

## Approval System

Jazz has a two-phase approval system for dangerous operations:

### Phase 1: Request Approval

Agent detects a dangerous operation (delete, rm, push, etc.) and asks for approval with details.

### Phase 2: Execute After Approval

If you approve, agent executes the operation using a special execution tool.

**Example:**

```
You: Delete emails older than 30 days with label "spam"

Agent: [Searches and finds 45 emails]

📧 Email Preview:
Subject: Get rich quick!
From: spam@example.com
Date: 45 days ago (2023-11-30)

⚠️ About to PERMANENTLY DELETE this email and 44 others. This cannot be undone!

If you want to proceed, I'll execute the deletion.

You: yes

Agent: [Executes deletion]
✓ Deleted 45 emails successfully.
```

## Tips for Effective Agent Usage

### 1. Be Specific

❌ Bad: "Check my email"
✅ Good: "Show me unread emails from the last 3 days"

### 2. Use Natural Language

You don't need to know technical commands:

- "Show me what changed in the repo" → git status
- "Find files containing 'TODO'" → grep -r "TODO"
- "Create a folder called 'backup'" → mkdir backup

### 3. Chain Operations

Ask agents to do multiple things:

"Search for emails from GitHub, label them as 'dev', and show me the ones that mention my username"

### 4. Review Approvals Carefully

Always read approval messages before saying "yes":

- Check file paths
- Verify email counts
- Review command details

### 5. Use /new for Fresh Context

If a conversation gets too long or confusing, use `/new` to start fresh while keeping the same agent configuration.

## Troubleshooting

### "No LLM providers configured"

**Solution**: Add at least one LLM API key to `~/.jazz/config.json`

### "Gmail authentication required"

**Solution**: Run `jazz auth gmail login` and complete OAuth flow

### "Command execution failed"

**Solution**: Check that you're in the right directory using `pwd` or specify full paths

### "Rate limit exceeded"

**Solution**: Wait a moment before retrying, or upgrade your LLM provider plan

### Agent not responding

**Solution**:

1. Check your internet connection
2. Verify API keys are valid
3. Try with `--debug` flag: `jazz --debug agent chat my-agent`

## Next Steps

Now that you're up and running:

1. **Explore Tools**: Read [tools-reference.md](tools-reference.md) to see all capabilities
2. **Set Up Integrations**: Add [Gmail](integrations.md#gmail-integration) and [Linkup](integrations.md#linkup-web-search)
3. **Check Security**: Read [security.md](security.md) for best practices
4. **Join Community**: Join our [Discord](https://discord.gg/yBDbS2NZju) for help and ideas

## Quick Reference

```bash
# Agent Management
jazz agent create              # Create new agent
jazz agent list               # List all agents
jazz agent chat <name>        # Chat with agent
jazz agent edit <id>          # Edit agent
jazz agent delete <id>        # Delete agent

# Gmail Authentication
jazz auth gmail login         # Connect Gmail
jazz auth gmail status        # Check status
jazz auth gmail logout        # Disconnect

# Options
--verbose, -v                 # Detailed output
--debug                       # Debug mode
--config <path>              # Custom config file
```

---

**Need help?** Join our [Discord](https://discord.gg/yBDbS2NZju) or check [GitHub Issues](https://github.com/lvndry/jazz/issues)
