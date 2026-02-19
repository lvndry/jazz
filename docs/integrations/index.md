# Integrations

Jazz supports various third-party integrations to enhance your agents' capabilities. This guide covers how to set up and configure each integration.

## Table of Contents

- [LLM Providers](#llm-providers)
- [Email & Calendar (Skills)](#email--calendar-skills)
- [Web Search](#web-search)
- [MCP Servers](#mcp-servers)
- [Configuration Examples](#configuration-examples)

---

## LLM Providers

Jazz supports multiple LLM providers. You need at least one configured to create agents.
You can set or update your API keys in config by running `jazz` -> `update configuration`

### OpenAI

**Setup**:

**Capabilites**: Latest OpenAI models with advanced tool use

1. Get your API key from [OpenAI Platform](https://platform.openai.com/api-keys)
2. Add to your config:

```json
{
  "llm": {
    "openai": {
      "api_key": "sk-..."
    }
  }
}
```

**Supported Models:** [`src/core/constants/models.ts`](../src/core/constants/models.ts#L13-L27)

### Anthropic

**Capabilities**: Claude Sonnet, Haiku and Opus with advanced tool use

**Setup**:

1. Get your API key from [Anthropic Console](https://console.anthropic.com/)
2. Add to your config:

```json
{
  "llm": {
    "anthropic": {
      "api_key": "sk-ant-..."
    }
  }
}
```

**Supported Models:** [`src/core/constants/models.ts`](../src/core/constants/models.ts#L28-L32)

### Google Gemini

**Capabilities**: Gemini Pro and Flash models with multimodal support

**Setup**:

1. Get your API key from [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Add to your config:

```json
{
  "llm": {
    "google": {
      "api_key": "AIza..."
    }
  }
}
```

**Supported Models:** [`src/core/constants/models.ts`](../src/core/constants/models.ts#L33-L42)

### Mistral AI

**Capabilities**: Mistral models with strong reasoning

**Setup**:

1. Get your API key from [Mistral Console](https://console.mistral.ai/)
2. Add to your config:

```json
{
  "llm": {
    "mistral": {
      "api_key": "mist..."
    }
  }
}
```

**Supported Models:** [`src/core/constants/models.ts`](../src/core/constants/models.ts#L43-L49)

### xAI (Grok)

**Capabilities**: Grok models with real-time information

**Setup**:

1. Get your API key from [xAI Console](https://console.x.ai/)
2. Add to your config:

```json
{
  "llm": {
    "xai": {
      "api_key": "xai-..."
    }
  }
}
```

**Supported Models:** [`src/core/constants/models.ts`](../src/core/constants/models.ts#L50-L65)

### DeepSeek

**Capabilities**: Cost-effective models with strong reasoning

**Setup**:

1. Get your API key from [DeepSeek Platform](https://platform.deepseek.com/)
2. Add to your config:

```json
{
  "llm": {
    "deepseek": {
      "api_key": "sk-..."
    }
  }
}
```

**Supported Models:** [`src/core/constants/models.ts`](../src/core/constants/models.ts#L66)

### Ollama (Local Models)

**Capabilities**: Run models locally without API keys

**Setup**:

1. Install Ollama from [ollama.ai](https://ollama.ai/)
2. Pull a model: `ollama pull llama3.2`
3. Jazz will auto-detect available models from your Ollama instance.

---

## Email & Calendar (Skills)

Jazz uses **skills** for email and calendar—agents run Himalaya and khal via `execute_command`. This is provider-agnostic and works with Gmail, Outlook, iCloud, Fastmail, and more.

### Email (Himalaya Skill)

Use the **email** skill with [Himalaya CLI](https://github.com/pimalaya/himalaya) for inbox management. Himalaya works with Gmail, Outlook, iCloud, Proton Mail, and more via IMAP/SMTP.

- **Setup**: Install Himalaya (`brew install himalaya`), run `himalaya account configure` for your provider
- **Agents**: Load the `email` skill—it teaches agents to use Himalaya for list, read, send, reply, search, and organize
- **Provider-agnostic**: One setup works across Gmail, Outlook, iCloud, Fastmail, etc.

### Calendar (khal Skill)

Use the **calendar** skill with [khal](https://github.com/pimutils/khal) and [vdirsyncer](https://github.com/pimutils/vdirsyncer) for event management. Works with Google Calendar, iCloud, Nextcloud, Fastmail, and any CalDAV server.

- **Setup**: Install khal and vdirsyncer, configure CalDAV in vdirsyncer, point khal at the synced calendars
- **Agents**: Load the `calendar` skill—it teaches agents to use khal for listing, creating, editing, and searching events
- **Sync**: Run `vdirsyncer sync` before reads to ensure up-to-date data

---

## Web Search

Enable your agents to search the web and get current information.

[Linkup](https://www.linkup.so/) and [Exa](https://exa.ai/) provide high-quality web search optimized for AI agents.

### Why Linkup/Exa?

- **AI-Optimized Results**: Structured data perfect for agents
- **Deep Search Mode**: Comprehensive research capabilities
- **Source Attribution**: Always know where information comes from
- **Fresh Content**: Access to current web information

### Setup Steps

#### 1. Get API Key

1. Visit [linkup.so](https://www.linkup.so/) or [exa.ai](https://exa.ai/)
2. Sign up for an account
3. Navigate to your dashboard
4. Copy your API key

#### 2. Add to Jazz Configuration

```sh
jazz config set linkup # jazz config set linkup.api_key <YOUR_LINKUP_API_KEY>
jazz config set exa # jazz config set exa.api_key <YOUR_EXA_API_KEY>
```

### Web Search Capabilities

Your agents can now:

- **Standard Search**: Quick results for common queries
- **Deep Search**: Comprehensive research with multiple sources
- **Sourced Answers**: AI-friendly format with citations
- **Raw Results**: Direct search results for parsing
- **Image Search**: Optional image results

### Usage Example

```bash
jazz agent chat my-agent

You: Search for the latest TypeScript 5.5 features

Agent: [Uses web_search]
       Based on recent web sources:

       TypeScript 5.5 introduces:
       1. Inferred Type Predicates
       2. Control Flow Narrowing Improvements
       3. [More features...]

       Sources:
       - TypeScript Blog
       - GitHub Release Notes
       - Dev.to Articles
```

---

## MCP Servers

Jazz supports [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers, allowing your agents to connect to external tools and services. MCP is an open standard that enables AI assistants to interact with various data sources and APIs.

### What is MCP?

MCP (Model Context Protocol) provides a standardized way for AI agents to:

- **Access external tools**: Connect to databases, APIs, and services
- **Use custom capabilities**: Extend agents with domain-specific functionality
- **Maintain context**: Share information across tool calls

### Configuration

Jazz loads MCP servers from multiple locations (later sources override earlier ones):

1. **Main config** — `jazz.config.json` or `.jazz/config.json` (see [Configuration Reference](../reference/configuration.md))
2. **`.agents/mcp.json`** — Project-level and user-level, following the [.agents convention](https://agentskills.io)

Add MCP servers to any of these files under the `mcpServers` key:

```json
{
  "mcpServers": {
    "serverName": {
      "command": "npx",
      "args": ["-y", "package-name", "additional-args"],
      "env": {
        "API_KEY": "your-api-key"
      }
    }
  }
}
```

**.agents/mcp.json** locations (merged in order, project overrides user):

- `~/.agents/mcp.json` — User-level (shared across projects)
- `./.agents/mcp.json` — Project-level (in your repo root)

#### Configuration Options

| Field     | Type       | Required | Description                                |
| --------- | ---------- | -------- | ------------------------------------------ |
| `command` | `string`   | Yes      | The command to start the MCP server        |
| `args`    | `string[]` | No       | Command line arguments                     |
| `env`     | `object`   | No       | Environment variables passed to the server |

### Assigning MCP Servers to Agents

When creating or editing an agent, you can assign MCP server tools:

```bash
jazz agent create
# During creation, select MCP tools from the available servers
```

Or configure directly in your agent's config:

```json
{
  "agents": {
    "my-agent": {
      "tools": ["Notionmcp", "Mongodb"]
    }
  }
}
```

> **Note**: Tool names are case-insensitive and derived from the server name (e.g., `notionMCP` → `Notionmcp`).

---

### Popular MCP Servers

#### Notion

Connect to your Notion workspace to search, read, and manage pages.

```json
{
  "mcpServers": {
    "notionMCP": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.notion.com/mcp"]
    }
  }
}
```

**Available Tools**:

- `notion-search` - Search pages and databases
- `notion-fetch` - Get page content
- `notion-create-pages` - Create new pages
- `notion-update-page` - Update existing pages
- `notion-create-database` - Create databases
- And more...

**Setup**: Authentication is handled via the Notion MCP remote server. The first time you use it, you'll be prompted to authorize access to your Notion workspace.

---

#### MongoDB

Query and manage MongoDB databases directly from your agents.

```json
{
  "mcpServers": {
    "MongoDB": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-mongodb"],
      "env": {
        "MONGODB_URI": "mongodb://localhost:27017"
      }
    }
  }
}
```

**Available Tools**:

- `find` - Query documents
- `aggregate` - Run aggregation pipelines
- `count` - Count documents
- `list-collections` - List all collections
- `list-databases` - List all databases
- `collection-schema` - Get collection schema
- And more...

---

#### PostgreSQL

Connect to PostgreSQL databases for SQL queries. The server accepts the connection string as a command-line argument.

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://user:pass@localhost:5432/dbname"]
    }
  }
}
```

**Available Tools**:

- `query` - Execute SQL queries
- `list-tables` - List database tables
- `describe-table` - Get table schema

---

#### GitHub

Access GitHub repositories, issues, and pull requests.

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."
      }
    }
  }
}
```

**Setup**:

1. Create a [GitHub Personal Access Token](https://github.com/settings/tokens)
2. Grant necessary permissions (repo, read:user, etc.)
3. Add the token to your config

**Available Tools**:

- Search repositories, issues, PRs
- Read file contents
- Create/update issues
- Manage pull requests

---

#### Slack

Send messages and interact with Slack workspaces.

```json
{
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-slack"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-...",
        "SLACK_TEAM_ID": "T..."
      }
    }
  }
}
```

**Setup**:

1. Create a [Slack App](https://api.slack.com/apps)
2. Add necessary OAuth scopes
3. Install to your workspace
4. Copy the Bot Token

---

#### Filesystem

Access and manage local files.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/directory"]
    }
  }
}
```

**Security**: Only files within the specified directory can be accessed.

---

#### Custom HTTP MCP Servers

For MCP servers running over HTTP (Streamable HTTP transport):

```json
{
  "mcpServers": {
    "my-http-server": {
      "url": "https://my-mcp-server.example.com/mcp",
      "headers": {
        "Authorization": "Bearer your-token"
      }
    }
  }
}
```

---

### Finding More MCP Servers

- **Official Registry**: [modelcontextprotocol.io/servers](https://modelcontextprotocol.io/servers)
- **GitHub**: Search for `mcp-server-` prefixed packages
- **npm**: Search for `@modelcontextprotocol/server-`

### Troubleshooting

**"Invalid arguments" Error**:

- The MCP server requires specific arguments that weren't provided
- Check the server's documentation for required parameters
- Verify your agent is passing the correct arguments

**"Tool not found" Error**:

- Ensure the MCP server is configured in `jazz.config.json`
- Verify the server name matches the agent's tool configuration
- Check that the server starts successfully (check logs)

**Connection Errors**:

- Verify the command and args are correct
- Check that required packages are installed (`npx -y` should auto-install)
- Review environment variables for missing credentials

**Authentication Errors**:

- Verify API keys/tokens are correct
- Check that credentials have necessary permissions
- Some servers require manual authorization flow
