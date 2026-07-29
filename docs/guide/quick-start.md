# Quick start

**Reader job:** get from nothing to a working agent.

## 1. Install the CLI

Jazz is available via npm, bun, pnpm, or yarn.

```bash
# npm
npm install -g jazz-ai

# bun
bun add -g jazz-ai

# pnpm
pnpm add -g jazz-ai

# yarn
yarn global add jazz-ai
```

## 2. Start talking to it

```bash
jazz
```

On first run Jazz walks you through provider setup and creates an agent. After that, `jazz`
drops you straight into a conversation.

Jazz itself is free and always will be — it's MIT-licensed with no account and no tiers. The
only variable cost is the model you choose, and there are two ways to make that zero:

- **Start using Jazz for free** — choose [OpenRouter](https://openrouter.ai) and the
  [`Free Models Router`](https://openrouter.ai/openrouter/free) model. No credit card.
- **Keep it entirely local** — choose `ollama`, and the model runs on your machine too.

## 3. Update Jazz

Keep Jazz up to date with the latest features and improvements:

```bash
jazz update
```

## Next steps

- **[Creating agents](./creating-agents.md)** — configure one for a specific job
- **[Surfaces](../surfaces/index.md)** — run the same agent headless, on a schedule, in CI, or in a chat thread
- **[Cookbook](../cookbook/index.md)** — copy-pasteable recipes
- **[Use cases](./use-cases/deep-research.md)** — end-to-end walkthroughs
