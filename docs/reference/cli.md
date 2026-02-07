# CLI Reference

## Global Flags

- `--version`: Show version number
- `--help`: Show help

## Commands

### `jazz agent`

Manage your AI agents.

- `create`: Create a new agent.
- `list`: List all available agents.
- `edit <id>`: Configure an existing agent.
- `delete <id>`: Remove an agent.
- `chat <name>`: Start a session with a specific agent.

### `jazz groove`

Manage automated grooves.

- `list`: Show available groove files.
- `run <name>`: Manually trigger a groove.
- `schedule <name>`: Add a groove to the system scheduler.
- `scheduled`: List currently scheduled grooves.

### `jazz config`

- `show`: detailed view of current configuration.
- `set <key> <value>`: Update a configuration value.

### `jazz auth`

- `gmail login`: Authenticate with Google for email skills.
- `logout`: Clear credentials.

### `jazz update`

Self-update Jazz to the latest version.
