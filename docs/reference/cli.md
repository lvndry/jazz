# CLI Reference

## Global Flags

- `--version`: Show version number
- `--help`: Show help
- `--no-tui`: Disable the interactive TUI; use plain terminal output (for CI, scripts, or small terminals). Same as `JAZZ_NO_TUI=1`.
- `--output <mode>`: Output mode: `rendered`, `hybrid` (default), `raw`, or `quiet`.

## Streaming Output

When using the interactive TUI, agent responses stream in append-only mode so
you can scroll back without losing earlier lines. Output formatting still
respects `--output` (`rendered`, `hybrid`, `raw`).

## Commands

### `jazz agent`

Manage your AI agents.

- `create`: Create a new agent.
- `list`: List all available agents.
- `edit <id>`: Configure an existing agent.
- `delete <id>`: Remove an agent.
- `chat <name>`: Start a session with a specific agent.

### `jazz workflow`

Manage automated workflows.

- `list`: Show available workflow files.
- `run <name>`: Manually trigger a workflow.
- `schedule <name>`: Add a workflow to the system scheduler.
- `scheduled`: List currently scheduled workflows.

### `jazz config`

- `show`: detailed view of current configuration.
- `set <key> <value>`: Update a configuration value.

### `jazz auth`

- `gmail login`: Authenticate with Google for email skills.
- `logout`: Clear credentials.

### `jazz update`

Self-update Jazz to the latest version.
