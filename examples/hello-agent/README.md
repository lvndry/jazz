# Hello Agent — Quick Example

This guide shows, step-by-step, how to create a minimal "hello" agent with Jazz and start a conversation. The goal is to give a tiny, zero-friction sample so newcomers can see Jazz in action in under five minutes.

What you'll get

- Create a simple agent via the interactive CLI wizard
- Start a chat session with that agent
- See how the agent can answer and (optionally) call simple tools

Prerequisites

- Jazz CLI installed (see README). Example:

```bash
# npm
npm install -g jazz-ai
```

- Optional: an API key for an LLM provider (OpenAI, etc.). You do not need to set this before running the wizard — the wizard will prompt for it if missing.

Create a minimal "hello" agent (step-by-step)

1. Start the agent creation wizard

```bash
jazz agent create
```

2. Follow the interactive prompts. For a minimal hello agent, you can use these example answers:

- What would you like to name your agent? `hello-agent`
- What should this agent do? `Greet me and answer simple questions about the repo`
- Select LLM provider: choose one from the list (e.g. `OpenAI`). If you don't have an API key configured, the wizard will ask you to enter it now.
- Select model: pick a model (e.g. `gpt-4o` or any available)
- Select tools: for the hello agent you can skip tools, or select `File System` if you want the agent to inspect files

When finished, the wizard will create and save the agent to your local storage.

Start a chat with your agent

1. List available agents to confirm creation

```bash
jazz agent list
```

You should see an entry for `hello-agent` in the list.

2. Start chatting

```bash
jazz agent chat hello-agent
```

3. Example conversation

```
You: Hi
Agent: Hello! I'm your hello-agent. I can answer simple questions about this repository. What would you like to know?
You: What's in the README?
Agent: The README introduces Jazz, shows install options, and explains how to create and chat with agents. It also links to docs and community channels.
You: Thanks!
Agent: You're welcome. Would you like me to open the README file and show the first section? (requires file access)
```

Note: when the agent asks to run actions that change state or read files it will request your approval. Approve or decline as you prefer.

If the agent asks for an API key during creation

- The wizard makes it easy: paste the key when prompted and it will be stored in your local config.
- Alternatively, run `jazz config set llm.<provider>.api_key <key>` before creating the agent.
