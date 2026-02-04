# Creating Custom Agents

Jazz allows you to create specialized agents tailored to specific tasks.

## The `jazz agent create` Command

To create a new agent, use the `create` command. You can configure the agent's name, the model it uses, and the skills it has access to.

```bash
jazz agent create
```

This will launch an interactive wizard.

## Command Line Flags

You can also specify options directly:

```bash
jazz agent create --name "Code Reviewer" --model "anthropic:claude-3-opus" --skills "git,code-review"
```

## Agent Configuration

Agents are stored in `~/.jazz/agents.json`. You can edit this file manually or use `jazz agent edit <id>`.

## Choosing a Model

Jazz supports multiple providers:

- `anthropic:...`
- `openai:...`
- `google:...`
- `ollama:...` (for local models)

Pick the model that best balances speed, cost, and intelligence for your specific task.
