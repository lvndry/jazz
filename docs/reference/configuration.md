# Configuration Reference

Jazz is configured via configuration files and environment variables.

## Configuration File Locations

Jazz loads configuration from two layers:

1. **`~/.jazz/config.json`** — Global config (agents, API keys, defaults). All writes go here.
2. **`./.jazz/config.json`** — Optional project-local overrides (like `.claude/`). Read-only merge on top of global.

Merge order: defaults → `~/.jazz/config.json` → `./.jazz/config.json`.

Agents and storage always live in the Jazz home directory (`~/.jazz` or `JAZZ_HOME`), even when project overrides exist.

You can replace the global config path with `$JAZZ_CONFIG_PATH` or `--config`. Project-local `./.jazz/config.json` still merges on top.

Legacy `./jazz.config.json` in the project root is no longer discovered automatically. Move settings to `~/.jazz/config.json`.

## MCP Servers: `.agents/mcp.json`

Jazz also loads MCP servers from the `.agents` convention paths. These are merged with the main config (project overrides user):

- `~/.agents/mcp.json` — User-level MCP config
- `./.agents/mcp.json` — Project-level MCP config

See [MCP Servers](../integrations/index.md#mcp-servers) for format details.

## Main Config: `~/.jazz/config.json`

```json
{
  "defaultModel": "anthropic:claude-3-5-sonnet",
  "theme": "dark",
  "notifications": true,
  "autoUpdate": true,
  "logLevel": "info"
}
```

## Project Overrides: `./.jazz/config.json`

Use for project-specific settings such as MCP enable/disable flags or logging level. Do not put agent storage paths here — agents always load from `~/.jazz`.

## Environment Variables

You can override settings or provide API keys via `.env` or system environment variables.

- `OPENAI_API_KEY`: Key for OpenAI models.
- `ANTHROPIC_API_KEY`: Key for Anthropic models.
- `JAZZ_HOME`: Override the Jazz home directory (default: `~/.jazz`). Use when developing Jazz to isolate test data.
- `JAZZ_CONFIG_PATH`: Override the global config file path.
- `DEBUG`: Set to `true` for verbose logging.
