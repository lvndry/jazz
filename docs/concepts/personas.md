---
description: "Use Jazz personas to share behavioral instructions and tool-profile restrictions across multiple AI agents without duplicating configuration."
---

# Personas in Jazz

A persona is a reusable system prompt. It defines how an agent approaches work and may narrow the built-in tool profile shared by agents using it.

Jazz ships small default, coder, researcher, and summarizer personas. Personal personas live under the Jazz data directory; installable community personas come from the repository marketplace.

Use a persona for behavior that should be shared across agents. Use agent configuration for provider, model, credentials, memory scopes, custom tools, and restrictions specific to one agent.

Persona instructions do not override harness security. They cannot grant a tool that was not registered, undo `deniedTools`, bypass a disclosure ceiling, or change the active approval policy.

Commands:

```bash
jazz persona list
jazz persona show coder
jazz persona browse
jazz persona install <name>
```

For a complete example, build the [Goggins accountability persona](../guides/goggins-accountability-agent.md) and reuse it in interactive, scripted, and scheduled runs.
