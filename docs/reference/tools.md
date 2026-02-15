# Tools Reference

Jazz comes with a suite of strict, type-safe tools that agents can use.

## Core Tools

### File System

- `read_file`: Read content of a file.
- `write_file`: Create or overwrite a file.
- `list_dir`: List files in a directory.
- `grep_search`: Search for patterns in files.
- `mv`: Move or rename a file or directory.
- `cp`: Copy a file or directory.

### Git

- `git_status`: Check repo status.
- `git_diff`: See pending changes.
- `git_commit`: Verify and commit changes.
- `git_log`: View history.

### Browser (via `browser-use`)

- `open_url`: Navigate to a page.
- `click`: Interact with elements.
- `type`: Enter text.
- `extract_data`: Get structured data from page.

### Communication

- `send_email`: Send an email (requires interaction).
- `read_email`: Search and read emails.

### Utilities

- `run_command`: Execute safe shell commands.
- `search_web`: Query search engines.
- `get_time`: Get current time.

_Note: This list is dynamically extended by installed skills._
