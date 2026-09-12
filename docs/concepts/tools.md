---
description: "Understand Jazz agent tools, tool schemas, progressive disclosure, risk levels, data disclosure, network egress, MCP tools, and custom tools."
---

# Tools in Jazz

A tool is a typed operation the model may request. Each registered tool has a name, description, input schema, handler, and security metadata.

## How a tool reaches an agent

Jazz registers built-in, MCP, skill-support, and agent-defined custom tools. It then resolves the agent and persona grants, subtracts explicit denials, applies caller requirements, and exposes the surviving tools to the model.

Always-on tools include their full schema in the model request. Deferred categories expose a small name-and-summary index; the model uses `search_tools` to load full schemas only when needed. This keeps large MCP and background-operation catalogs from consuming context on every turn.

## Three security properties

- **Risk** asks whether executing the tool can change state or cause harm.
- **Disclosure** asks what class of information its result may reveal.
- **Egress** asks whether data leaves the local process.

These are intentionally separate. A read-only search may send a private query to a network service, while a local filesystem write mutates state without network egress.

See the code-verified [tool inventory](../tools/index.md), [Approvals](../security/approvals.md), and [Custom tools](../configure/agents.md#custom-tools).
