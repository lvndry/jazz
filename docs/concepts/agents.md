# Concept: Agents

## What is an Agent?

In Jazz, an **Agent** is the autonomous entity that performs tasks for you. Unlike a simple chatbot that executes one prompt and stops, a Jazz Agent is designed to be persistent, context-aware, and capable of executing multi-step workflows.

## Anatomy of an Agent

### 1. Identify & Configuration

Every agent has a unique identity and configuration:

- **Name**: A human-readable name (e.g., "Senior Developer", "Researcher").
- **Model**: The underlying LLM brain (e.g., `anthropic/claude-4-5-sonnet`, `openai/gpt-5.2`).
- **System Prompt**: Instructions that define its personality, constraints, and base capabilities.
- **Persona** (optional): A custom [persona](./personas.md) that overrides or augments the agent type—shaping tone, style, and behavior.

### 2. Skills

Agents are granted **Skills**, which are bundles of tools and knowledge.

- A "Coder" agent might have `git`, `fs` (filesystem), and `code-review` skills.
- A "Secretary" agent might have `calendar`, `email`, and `reminder` skills.

### 3. Loop & Execution

When you give an agent a task, it enters an **Execution Loop**:

1.  **Think**: The agent analyzes the history and the current request.
2.  **Act**: It decides to call a tool (e.g., "read file", "search web").
3.  **Observe**: The tool executes and returns a result to the agent.
4.  **Repeat**: The agent uses this new information to decide the next step.
5.  **Respond**: Once the task is done, it communicates the final result to you.

## Types of Agents (Patterns)

While all agents share the same code structure, you can create different "types" by varying their configuration:

- **Generalist**: Has a wide array of tools (Web, File, Git). Good for generic tasks.
- **Specialist**: Has a narrow set of tools context. (e.g., an "Editor" that can only read files and suggest changes, but not write).
- **Router**: An agent designed to delegate work to other sub-agents or workflows (future concept).

## Agent Storage

Agents are persisted in `~/.jazz/agents.json`. This allows them to "remember" who they are across different CLI sessions, although currently, conversation history is session-based.
