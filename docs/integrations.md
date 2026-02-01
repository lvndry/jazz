# Integrations

Jazz supports various third-party integrations to enhance your agents' capabilities. This guide covers how to set up and configure each integration.

## Table of Contents

- [LLM Providers](#llm-providers)
- [Gmail Integration](#gmail-integration)
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

## Google Services (Gmail & Calendar)

Enable your agents to manage Gmail (read, search, send emails, manage labels) and Google Calendar (manage events, check availability, schedule meetings).

### Prerequisites

- A Google account
- Access to [Google Cloud Console](https://console.cloud.google.com/)

### Setup Steps

#### 1. Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click **Select a project** → **New Project**
3. Name your project (e.g., "Jazz Agent")
4. Click **Create**

#### 2. Enable APIs

1. In your project, go to **APIs & Services** → **Library**
2. Search for and enable:
   - **Gmail API** - Click **Enable**
   - **Google Calendar API** - Click **Enable**

#### 3. Configure OAuth Consent Screen

1. Go to **APIs & Services** → **OAuth consent screen**
2. Choose **External** (unless you have Google Workspace)
3. Click **Create**
4. Fill in required fields:
   - **App name**: "Jazz Agent" (or your choice)
   - **User support email**: Your email
   - **Developer contact**: Your email
5. Click **Save and Continue**
6. On **Scopes** page:
   - Click **Add or Remove Scopes**
   - Add these scopes:
     - `https://mail.google.com/` (Full Gmail access)
     - `https://www.googleapis.com/auth/calendar` (Calendar access)
     - `https://www.googleapis.com/auth/calendar.events` (Calendar events)
   - Click **Update** → **Save and Continue**
7. On **Audience** → **Test users** page:
   - Click **Add Users**
   - Add your Gmail address
   - Click **Save and Continue**

> **Note**: Both Gmail and Calendar share the same OAuth credentials and authentication tokens. You only need to set up OAuth once for both services.

#### 4. Create OAuth Credentials

1. Go to **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **OAuth client ID**
3. Choose **Desktop app** as application type
4. Name it "Jazz CLI"
5. Click **Create**
6. Click **Save**
7. Copy/Download the credentials JSON or copy the Client ID and Client Secret

#### 5. Add to Jazz Configuration

To setup the configuration, run:

```bash
jazz config set google
```

And paste your client id and client secret when prompted.

#### 6. Authenticate

```bash
# Authenticate with Gmail (also enables Calendar)
jazz auth gmail login

# OR authenticate with Calendar (also enables Gmail)
jazz auth calendar login

# This will:
# 1. Open your browser
# 2. Ask you to sign in to Google
# 3. Request permissions for Gmail and Calendar access
# 4. Redirect back to Jazz (localhost)
# 5. Store authentication tokens securely

# Verify  authentication
jazz auth gmail status
jazz auth calendar status
```

> **Note**: Gmail and Calendar share authentication tokens. Authenticating with either service grants access to both.

#### 7. Create an Agent with Google Tools

```bash
jazz agent create

# During creation:
# - Choose tools → Select "Gmail" and/or "Calendar" categories
# - This gives your agent access to Gmail and Calendar operations
```

### Gmail Tool Capabilities

Your agents can now:

- **Read Emails**: List, search, get full content
- **Send & Draft**: Compose and send emails on your behalf
- **Label Management**: Create, update, delete, apply labels
- **Email Actions**: Trash, delete, archive with approval
- **Batch Operations**: Modify multiple emails at once
- **Smart Search**: Use Gmail's powerful query syntax

### Calendar Tool Capabilities

Your agents can now:

- **Read Events**: List, search, get event details
- **Create Events**: Schedule meetings with title, time, attendees, location
- **Update Events**: Modify existing events (reschedule, change details)
- **Delete Events**: Remove cancelled events
- **Quick Add**: Create events from natural language ("meeting tomorrow at 2pm")
- **List Calendars**: Access all subscribed calendars
- **Search**: Find events by text across titles, descriptions, and locations
- **Upcoming Events**: Quickly check what's coming up

### Security & Privacy

- **Token Storage**: Tokens are stored locally in `~/.jazz/google/gmail-token.json`
- **User Approval**: Destructive operations (delete, trash) require explicit approval
- **Read-Only by Default**: Agents can read freely but must ask before modifying
- **Revoke Access**: Run `jazz auth gmail logout` or revoke in [Google Account Settings](https://myaccount.google.com/permissions)

### Troubleshooting Gmail

**"Invalid Client" Error**:

- Verify redirect URI is exactly `http://localhost:53682/oauth2callback`
- Check Client ID and Secret are correct
- Ensure Gmail API is enabled

**"Access Blocked" Error**:

- Add your email as a test user in OAuth consent screen
- Verify scopes are configured correctly

**"Token Expired" Error**:

- Refresh tokens expire if unused for 6 months
- Re-authenticate: `jazz auth gmail login`

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

Add MCP servers to your `jazz.config.json` under the `mcpServers` key:

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

Connect to PostgreSQL databases for SQL queries.

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "${input:pg_url}"]
    }
  }
}
```

> **Note**: The `${input:pg_url}` syntax prompts you for the PostgreSQL connection URL on first use and stores it securely.

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
