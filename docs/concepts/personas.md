# Concept: Custom Personas

## What is a Persona?

A **Persona** is a reusable character or identity that shapes how an agent communicates. It defines tone, style, vocabulary, and behavioral rules through a system prompt. Personas are **decoupled from agents and models**—the same persona can be used with any agent running on any LLM provider.

### Built-in vs Custom Personas

Jazz ships with built-in **agent types** that double as personas:

| Type        | Description                                                                 |
| ----------- | --------------------------------------------------------------------------- |
| `default`   | General-purpose agent for various tasks.                                    |
| `coder`     | Expert software engineer: code analysis, debugging, implementation.         |
| `researcher`| Meticulous researcher: deep exploration, source synthesis, evidence-backed conclusions. |
| `summarizer`| Specialized in compressing conversation history (used internally).          |

**Custom personas** extend this with your own characters. You define the system prompt, and Jazz injects it into the agent's conversation—so you can have a sarcastic hacker, a formal tutor, a pirate, or any personality you want.

## How Personas Work

1. **Storage**: Custom personas are stored as JSON files in `~/.jazz/personas/` (or `./.jazz/personas/` when running from source).
2. **System prompt**: The persona's `systemPrompt` is the core. It is injected into the agent's system message and shapes how the model responds.
3. **Agent config**: You assign a persona to an agent via the `persona` field in the agent's configuration. When set, the persona's system prompt overrides or augments the agent type's behavior.
4. **Model-agnostic**: Personas work with any LLM—OpenAI, Anthropic, Google, Ollama, etc. The same persona behaves consistently across providers.

## Creating a Custom Persona

### Option 1: Create a JSON File Manually

Create a file at `.jazz/personas/<id>.json`. The filename (without `.json`) becomes the persona ID. Use a short UUID or a memorable slug.

**Schema:**

```json
{
  "id": "bdDPam5VWCthq7xvPuivHd",
  "name": "pirate",
  "description": "A friendly pirate who explains things in nautical terms.",
  "systemPrompt": "You are a jovial pirate assistant. Use nautical vocabulary (ahoy, matey, landlubber). Keep responses concise. When explaining technical concepts, relate them to sailing or the sea. Sign off with 'Fair winds!'",
  "tone": "playful",
  "style": "concise",
  "createdAt": "2026-02-17T00:00:00.000Z",
  "updatedAt": "2026-02-17T00:00:00.000Z"
}
```

**Fields:**

| Field         | Required | Description                                                                 |
| ------------- | -------- | --------------------------------------------------------------------------- |
| `id`          | Yes      | Unique identifier. Match the filename (without `.json`).                    |
| `name`        | Yes      | Alphanumeric, underscores, hyphens. Used for CLI references.               |
| `description` | Yes      | Brief human-readable description (max 500 chars).                           |
| `systemPrompt`| Yes      | Instructions that define how the persona behaves (max 10,000 chars).        |
| `tone`        | No       | Descriptor for display (e.g., "sarcastic", "formal", "friendly").          |
| `style`       | No       | Descriptor for display (e.g., "concise", "verbose", "technical").          |
| `createdAt`   | Yes      | ISO 8601 timestamp.                                                         |
| `updatedAt`   | Yes      | ISO 8601 timestamp.                                                         |

**Name rules**: Only letters, numbers, underscores, and hyphens. Examples: `cyber-punk`, `therapist`, `pirate`.

### Option 2: Programmatic Creation

The PersonaService exposes `createPersona`, `getPersona`, `listPersonas`, `updatePersona`, `deletePersona`, and `getPersonaByIdentifier`. Use these when building tooling or automation.

### Example Personas

**Sarcastic hacker:**
```json
{
  "id": "h4x0r",
  "name": "hacker",
  "description": "A sarcastic hacker who explains everything in l33t speak.",
  "systemPrompt": "You are a cyberpunk hacker. Use l33t speak and technical jargon. Be sarcastic but helpful. When the user makes a mistake, gently mock them. Always stay in character.",
  "tone": "sarcastic",
  "style": "technical",
  "createdAt": "2026-02-17T00:00:00.000Z",
  "updatedAt": "2026-02-17T00:00:00.000Z"
}
```

**Formal tutor:**
```json
{
  "id": "tutor",
  "name": "tutor",
  "description": "A patient, formal tutor who explains concepts step by step.",
  "systemPrompt": "You are a patient tutor. Use formal but warm language. Explain concepts step by step. Ask clarifying questions when needed. Summarize key points at the end.",
  "tone": "formal",
  "style": "verbose",
  "createdAt": "2026-02-17T00:00:00.000Z",
  "updatedAt": "2026-02-17T00:00:00.000Z"
}
```

## Applying a Persona to an Agent

To use a custom persona with an agent, set the `persona` field in the agent's configuration. You can reference the persona by **ID** or **name**.

**Edit the agent JSON** in `.jazz/agents/<id>.json` and add a `persona` field to the config:

```json
{
  "id": "my-agent-id",
  "name": "My Agent",
  "config": {
    "agentType": "default",
    "llmProvider": "openai",
    "llmModel": "gpt-4",
    "persona": "pirate"
  }
}
```

When `persona` is set, the persona's system prompt is used to shape the agent's behavior. The agent still uses its `agentType` for tool selection (e.g., summarizer has no tools); the persona primarily affects communication style.

## Persona Prompt Placeholders

When building the system prompt, Jazz replaces these placeholders if present in your persona's `systemPrompt`:

| Placeholder       | Description                    |
| ----------------- | ------------------------------ |
| `{agentName}`     | The agent's name               |
| `{agentDescription}` | The agent's description     |
| `{currentDate}`   | Current date                   |
| `{osInfo}`        | OS platform and version        |
| `{shell}`         | User's shell                   |
| `{hostname}`      | Machine hostname               |
| `{username}`      | Current username               |
| `{homeDirectory}` | User's home directory           |

Example:

```
You are {agentName}, a pirate assistant. Today is {currentDate}. You help {username} with their tasks. Fair winds!
```

## Managing Personas

- **List**: Persona files in `.jazz/personas/` are discovered automatically. Each `.json` file is one persona.
- **Update**: Edit the JSON file directly. Ensure `updatedAt` reflects the change.
- **Delete**: Remove the `.json` file from `.jazz/personas/`. Any agents referencing that persona will need to be updated.

## See Also

- [Agents](./agents.md) – How agents are configured and used
- [Creating Agents](../guide/creating-agents.md) – Step-by-step agent creation
- [CLI Reference](../reference/cli.md) – Command-line interface
