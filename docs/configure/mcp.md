---
description: "Connect Jazz agents to local and remote MCP servers with lazy startup, OAuth, deferred tool schemas, explicit trust, and per-agent tool selection."
---

# Connect MCP servers to Jazz

Model Context Protocol servers add tools, resources, and prompts supplied by another process or service. Use MCP when a maintained server already owns an integration; use a Jazz built-in tool for harness behavior and a skill for instructions around an existing CLI.

Jazz connects only to MCP servers referenced by the active agent. Connections and full tool schemas are lazy, so an unavailable server does not delay unrelated agents and a large catalog does not occupy the model context before a tool is needed.

## Add a local server

Pass the server command after `--` so its flags are not parsed as Jazz options:

```bash
jazz mcp add notes -- \
  npx -y @modelcontextprotocol/server-filesystem "$HOME/notes"
```

Jazz writes the definition to the standard user-level `~/.agents/mcp.json`. A repository can commit `./.agents/mcp.json`; project definitions override user definitions with the same name.

Equivalent JSON:

```json
{
  "mcpServers": {
    "notes": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/notes"]
    }
  }
}
```

Use `--env KEY=value` for values the child process needs. Treat committed project MCP definitions as executable configuration: review commands, packages, arguments, and environment access before running them.

## Add a remote server with OAuth

```bash
jazz mcp add cloudflare --transport http https://mcp.cloudflare.com/mcp
jazz mcp auth cloudflare
jazz mcp test cloudflare
```

Without static headers, Jazz performs the remote server's OAuth flow and stores the resulting tokens through its secret storage. `jazz mcp logout cloudflare` removes them.

For a service credential, `--header KEY=value` writes a static HTTP header to the MCP definition. Prefer OAuth when the server supports it; a literal header in `.agents/mcp.json` is plaintext configuration and must not be committed.

## Give the tools to an agent

```bash
jazz agent edit <agent-name>
```

Select the MCP server category in the tool picker. Jazz prefixes registered tool names with `mcp_<server>_`, preventing two servers with the same upstream tool name from colliding.

An agent connects only to servers implied by its selected MCP tools. Removing the category from that agent removes its access without disabling the server for every other agent.

## Trust controls approval, not identity

New MCP servers are untrusted. Jazz treats every tool from an untrusted server as high-risk even if the server labels it read-only. This prevents a hostile server from bypassing approval with dishonest annotations.

After reviewing who operates the server and how it describes tools, you may allow its annotations to influence risk:

```bash
jazz mcp trust notes
jazz mcp untrust notes
```

For a trusted server:

- `readOnlyHint` becomes `read-only`;
- `destructiveHint` remains `high-risk`;
- an unannotated tool becomes `low-risk`.

Trust does not auto-approve everything, grant filesystem access, or override the active run policy. It means Jazz may rely on that server's annotations when deciding which tools require approval.

## Inspect before using

```bash
jazz mcp list
jazz mcp list --tools
jazz mcp test <server>
```

`list --tools` connects to configured servers and shows advertised tools. `test` reports one server's tools, prompts, and capabilities. Use these commands before assigning an unfamiliar server to an agent.

## Large tool catalogs

Jazz initially gives the model tool names and short summaries. The agent calls `search_tools` to retrieve relevant full schemas. This keeps integrations such as Cloudflare's API—thousands of possible endpoints—usable without putting every parameter into every prompt.

Servers can announce a changed tool list during a live process. Jazz updates the registry, adds newly advertised tools, and removes retired ones without requiring a restart.

## Resources and prompts

When a server advertises MCP resources, Jazz exposes bounded resource-list and resource-read tools for that server. Catalogs and resource bodies are capped so one server cannot flood the model context.

MCP prompts are server-provided templates, not trusted system instructions. Treat their contents and every tool result as external input.

## Failure behavior

- A server that is not selected by the active agent is never connected.
- A selected server that cannot start or authenticate is reported as unavailable; the agent continues without its tools.
- OAuth required in a headless run fails with authorization guidance rather than opening an unusable browser flow.
- A tool removed by a server is unregistered from the live process.
- Invalid tool arguments are ultimately authoritative at the MCP server because JSON Schema conversion can be lossy.

## Configuration ownership

Full server definitions belong only in `~/.agents/mcp.json` or `./.agents/mcp.json`. Jazz configuration may override an existing server's `enabled` and `trusted` state, but command, URL, arguments, headers, and environment fields placed only in `~/.jazz/config.json` do not define a server.

```bash
jazz mcp disable <server>
jazz mcp enable <server>
jazz mcp remove <server>
```

## Security checklist

- Prefer the server's OAuth flow to committed bearer headers.
- Scope the upstream account and token independently of Jazz.
- Keep mutation tools unavailable to agents that only need reads.
- Leave third-party servers untrusted until their annotations and operator are acceptable.
- Treat tool results, resources, prompts, and tool-list changes as untrusted input.
- Apply network egress controls outside Jazz when a server must reach only specific hosts.

See the [Cloudflare incident-response tutorial](../guides/contain-cloudflare-attack.md) for a real remote MCP workflow, [Tools and approvals](../security/approvals.md) for gating, and [Secrets and egress](../security/secrets-and-egress.md) for the data boundary.
