# Configuration Reference

Jazz is configured via a global configuration file and environment variables.

## `jazz.config.json`

Located at `~/.jazz/config.json`.

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
