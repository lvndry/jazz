---
description: "Attach Model Context Protocol servers to a Jazz agent to connect external services: one line of config per server, tools appear in the agent's registry."
---

# MCP Servers

How to connect an agent to an external service.

Jazz speaks [Model Context Protocol](https://modelcontextprotocol.io/). Add a server with
`jazz mcp add`, then include its tools in an agent's tool list.

> **Servers connect lazily.** Jazz does not connect at startup — a server is launched the
> first time one of its tools is actually invoked, so a broken or slow server never blocks
> `jazz` from starting. See
> [Design decisions](../internals/design-decisions.md#lazy-mcp-connection).
>
> **Schemas load lazily too.** Once connected, a server's tools appear in the agent's prompt
> by name and one-line summary only — the model fetches a tool's full schema via `search_tools`
> the first time it needs one. See
> [Design decisions](../internals/design-decisions.md#deferred-tool-schemas).

---

Jazz supports [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers, allowing your agents to connect to external tools and services. MCP is an open standard that enables AI assistants to interact with various data sources and APIs.

## What is MCP?

MCP (Model Context Protocol) provides a standardized way for AI agents to:

- **Access external tools**: Connect to databases, APIs, and services
- **Use custom capabilities**: Extend agents with domain-specific functionality
- **Maintain context**: Share information across tool calls

## Configuration

**A server's full definition — `command`, `args`, `env` — only ever lives in `.agents/mcp.json`.**
`jazz mcp add` writes there for you; if you're editing by hand, that's the file to edit:

```json
// ~/.agents/mcp.json (user-level) or ./.agents/mcp.json (project-level, in your repo root)
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

Both locations merge, following the [.agents convention](https://agentskills.io) — project
overrides user on a name collision.

`~/.jazz/config.json` (and its project-local `./.jazz/config.json` override) can *also* declare
`mcpServers`, but only to toggle `enabled`/`trusted` on a server already defined above — a
`command`/`args`/`env` written here is silently ignored, not merged in:

```json
// ~/.jazz/config.json
{
  "mcpServers": {
    "serverName": { "enabled": false }
  }
}
```

If a tool you expect isn't showing up, check that the server itself is actually declared in
`.agents/mcp.json`, not just referenced from `~/.jazz/config.json`.

### Configuration Options

| Field     | Type       | Required | Description                                |
| --------- | ---------- | -------- | ------------------------------------------ |
| `command` | `string`   | Yes      | The command to start the MCP server        |
| `args`    | `string[]` | No       | Command line arguments                     |
| `env`     | `object`   | No       | Environment variables passed to the server |

## Assigning MCP Servers to Agents

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

## Popular MCP Servers

### Notion

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

### MongoDB

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

### PostgreSQL

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

### GitHub

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

### Slack

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

### Filesystem

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

### Custom HTTP MCP Servers

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

## Finding More MCP Servers

- **Official Registry**: [modelcontextprotocol.io/servers](https://modelcontextprotocol.io/servers)
- **GitHub**: Search for `mcp-server-` prefixed packages
- **npm**: Search for `@modelcontextprotocol/server-`

## Troubleshooting

**"Invalid arguments" Error**:

- The MCP server requires specific arguments that weren't provided
- Check the server's documentation for required parameters
- Verify your agent is passing the correct arguments

**"Tool not found" Error**:

- Ensure the MCP server is configured in `~/.jazz/config.json` or `./.jazz/config.json`
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

---

## Related

- [Integrations index](./index.md)
- [Configuration](../reference/configuration.md) — the full config file reference
- [LLM Providers](./providers.md)
