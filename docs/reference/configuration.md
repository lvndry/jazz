# Configuration Reference

Jazz is configured via configuration files and environment variables.

## Configuration File Locations

Jazz searches for config files in this order (first found wins):

1. `$JAZZ_CONFIG_PATH` — Path from environment variable
2. `./jazz.config.json` — Project-level
3. . `~/.jazz/config.json` — User-level (global)

## MCP Servers: `.agents/mcp.json`

Jazz also loads MCP servers from the `.agents` convention paths. These are merged with the main config (project overrides user):

- `~/.agents/mcp.json` — User-level MCP config

See [MCP Servers](../integrations/index.md#mcp-servers) for format details.

## Main Config: `jazz.config.json`

Located at `~/.jazz/config.json` (or project paths above).

```json
{
  "defaultModel": "anthropic:claude-3-5-sonnet",
  "theme": "dark",
  "notifications": true,
  "autoUpdate": true,
  "logLevel": "info"
}
```

## Environment Variables

You can override settings or provide API keys via `.env` or system environment variables.

- `OPENAI_API_KEY`: Key for OpenAI models.
- `ANTHROPIC_API_KEY`: Key for Anthropic models.
- `JAZZ_HOME`: Override the default home directory (default: `~/.jazz`).
- `DEBUG`: Set to `true` for verbose logging.
