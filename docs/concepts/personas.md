# Concept: Custom Personas

## What is a Persona?

A **Persona** is a reusable character or identity that shapes how an agent communicates. It defines tone, style, vocabulary, and behavioral rules through a system prompt. Personas are **decoupled from agents and models**—the same persona can be used with any agent running on any LLM provider.

### Built-in vs Custom Personas

Jazz ships with built-in personas:

| Type         | Description                                                                             |
| ------------ | --------------------------------------------------------------------------------------- |
| `default`    | General-purpose agent for various tasks.                                                |
| `coder`      | Expert software engineer: code analysis, debugging, implementation.                     |
| `researcher` | Meticulous researcher: deep exploration, source synthesis, evidence-backed conclusions. |
| `summarizer` | Specialized in compressing conversation history (used internally).                      |

**Custom personas** extend this with your own characters. You define the system prompt, and Jazz injects it into the agent's conversation—so you can have a sarcastic hacker, a formal tutor, a pirate, or any personality you want.

## How Personas Work

1. **Storage**: Jazz scans two directories for persona.md files (like skills and workflows):
   - **Built-in** (package `personas/<name>/persona.md`): `default`, `coder`, `researcher`, `summarizer` — shipped with Jazz
   - **Custom** (`~/.jazz/personas/<name>/persona.md`): Your own personas. When a custom persona has the same name as a built-in, the custom one takes precedence.

   Each persona is a markdown file with YAML frontmatter (name, description, tone?, style?) and the system prompt in the body.
2. **System prompt**: The persona's `systemPrompt` is the core. It is injected into the agent's system message and shapes how the model responds.
3. **Agent config**: You assign a persona to an agent via the `persona` field in the agent's configuration. The persona's system prompt shapes the agent's behavior.
4. **Model-agnostic**: Personas work with any LLM—OpenAI, Anthropic, Google, Ollama, etc. The same persona behaves consistently across providers.

## Creating a Custom Persona

### Option 1: Create a persona.md File Manually

Create a folder and file at `~/.jazz/personas/<name>/persona.md`. The folder name becomes the persona name. Use a memorable slug (e.g., `pirate`, `therapist`).

**Format:** YAML frontmatter + markdown body (the system prompt).

```markdown
---
name: pirate
description: A friendly pirate who explains things in nautical terms.
tone: playful
style: concise
---

You are a jovial pirate assistant. Use nautical vocabulary (ahoy, matey, landlubber). Keep responses concise. When explaining technical concepts, relate them to sailing or the sea. Sign off with 'Fair winds!'
```

**Frontmatter fields:**

| Field         | Required | Description                                                          |
| ------------- | -------- | -------------------------------------------------------------------- |
| `name`        | Yes      | Alphanumeric, underscores, hyphens. Used for CLI references.        |
| `description` | Yes      | Brief human-readable description (max 500 chars).                    |
| `tone`        | No       | Descriptor for display (e.g., "sarcastic", "formal", "friendly").    |
| `style`       | No       | Descriptor for display (e.g., "concise", "verbose", "technical").    |

**Body:** The system prompt. Can use markdown (headings, lists, etc.). Max 10,000 characters.

**Name rules**: Only letters, numbers, underscores, and hyphens. Examples: `cyber-punk`, `therapist`, `pirate`.

### Option 2: Programmatic Creation

The PersonaService exposes `createPersona`, `getPersona`, `listPersonas`, `updatePersona`, `deletePersona`, and `getPersonaByIdentifier`. Use these when building tooling or automation.

### Example Personas

**Sarcastic hacker** (`~/.jazz/personas/hacker/persona.md`):

```markdown
---
name: hacker
description: A sarcastic hacker who explains everything in l33t speak.
tone: sarcastic
style: technical
---

You are a cyberpunk hacker. Use l33t speak and technical jargon. Be sarcastic but helpful. When the user makes a mistake, gently mock them. Always stay in character.
```

**Formal tutor** (`~/.jazz/personas/tutor/persona.md`):

```markdown
---
name: tutor
description: A patient, formal tutor who explains concepts step by step.
tone: formal
style: verbose
---

You are a patient tutor. Use formal but warm language. Explain concepts step by step. Ask clarifying questions when needed. Summarize key points at the end.
```

## Applying a Persona to an Agent

To use a custom persona with an agent, set the `persona` field in the agent's configuration. You can reference the persona by **ID** or **name**.

**Edit the agent JSON** in `~/.jazz/agents/<id>.json` and set the `persona` field in the config:

```json
{
  "id": "my-agent-id",
  "name": "My Agent",
  "config": {
    "persona": "pirate",
    "llmProvider": "openai",
    "llmModel": "gpt-4"
  }
}
```

The `persona` field drives both communication style (via the system prompt) and tool selection. For example, the built-in `summarizer` persona has no tools; all other personas receive the default tool set plus any tools you configure on the agent.

## Persona Prompt Placeholders

When building the system prompt, Jazz replaces these placeholders if present in your persona's `systemPrompt`:

| Placeholder          | Description             |
| -------------------- | ----------------------- |
| `{agentName}`        | The agent's name        |
| `{agentDescription}` | The agent's description |
| `{currentDate}`      | Current date            |
| `{osInfo}`           | OS platform and version |
| `{shell}`            | User's shell            |
| `{hostname}`         | Machine hostname        |
| `{username}`         | Current username        |
| `{homeDirectory}`    | User's home directory   |

Example:

```
You are {agentName}, a pirate assistant. Today is {currentDate}. You help {username} with their tasks. Fair winds!
```

## Managing Personas

- **List**: Persona files in `~/.jazz/personas/<name>/persona.md` are discovered automatically.
- **Update**: Edit the persona.md file directly.
- **Delete**: Remove the persona folder (e.g. `~/.jazz/personas/pirate/`). Any agents referencing that persona will need to be updated.

## See Also

- [Agents](./agents.md) – How agents are configured and used
- [Creating Agents](../guide/creating-agents.md) – Step-by-step agent creation
- [CLI Reference](../reference/cli.md) – Command-line interface
