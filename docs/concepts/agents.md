---
description: "Learn how a Jazz agent combines a model provider, model, persona, tools, restrictions, memory scopes, and optional media companions."
---

# Agents in Jazz

An agent is the reusable identity Jazz runs. Its JSON file selects:

- a model provider and model;
- a [persona](./personas.md);
- additional or denied tools;
- optional custom tools and web-search provider;
- reasoning and context settings;
- memory scopes;
- optional image, audio, or video companion models.

## Minimal agent

```json
{
  "id": "reviewer",
  "name": "Reviewer",
  "config": {
    "persona": "coder",
    "llmProvider": "openai",
    "llmModel": "gpt-5.4"
  }
}
```

Create one interactively with `jazz agent create`. Agent files live under the active Jazz data directory and are shared by every surface using that installation.

`tools` is additive: it grants capabilities beyond the built-in bundle. `deniedTools` removes capabilities after all other grants and is the reliable way to enforce a per-agent ceiling.

An agent is not a running process or conversation. Each invocation resolves the current agent definition, builds the permitted toolset, then starts or resumes a conversation.

## Companion models

`companions` lets this identity borrow specialist models without switching the main model. Analysis
and generation bind independently for image, audio, and video:

```json
{
  "companions": {
    "analyze:image": "provider/vision-model",
    "analyze:audio": "provider/audio-model",
    "generate:image": "provider/image-generation-model"
  }
}
```

Companions are bounded, tool-free runs with isolated context. Analysis returns evidence; generation
returns an artifact. Neither creates a second identity or conversation. See
[Model companions](../features/media.md).

See [Create an agent](../getting-started/create-an-agent.md) for the workflow and
[Agent configuration](../configure/agents.md) for every field.
