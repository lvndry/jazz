# Web Search

How to give an agent live information from the web.

`web_search` needs a configured provider; without one it errors. `web_fetch` and
`http_request` need no key.

Each provider's key can come from an environment variable instead of the config file —
`BRAVE_API_KEY`, `EXA_API_KEY`, `LINKUP_API_KEY`, `PARALLEL_API_KEY`, `PERPLEXITY_API_KEY`,
`TAVILY_API_KEY` — or from your OS keyring. See
[Security → Know where your API keys live](../../SECURITY.md#know-where-your-api-keys-live).

---

Enable your agents to search the web and get current information.

[Linkup](https://www.linkup.so/) and [Exa](https://exa.ai/) provide high-quality web search optimized for AI agents.

## Why Linkup/Exa?

- **AI-Optimized Results**: Structured data perfect for agents
- **Deep Search Mode**: multi-hop research across several sources in one query
- **Source Attribution**: Always know where information comes from
- **Fresh Content**: Access to current web information

## Setup Steps

### 1. Get API Key

1. Visit [linkup.so](https://www.linkup.so/) or [exa.ai](https://exa.ai/)
2. Sign up for an account
3. Navigate to your dashboard
4. Copy your API key

### 2. Add to Jazz Configuration

```sh
jazz config set linkup # jazz config set linkup.api_key <YOUR_LINKUP_API_KEY>
jazz config set exa # jazz config set exa.api_key <YOUR_EXA_API_KEY>
```

## Web Search Capabilities

Your agents can now:

- **Standard Search**: Quick results for common queries
- **Deep Search**: multi-source research, slower and more expensive per query
- **Sourced Answers**: AI-friendly format with citations
- **Raw Results**: Direct search results for parsing
- **Image Search**: Optional image results

## Usage Example

```bash
jazz agent chat my-agent

You: Search for the latest TypeScript 5.5 features

Agent: [Uses web_search]
       Based on recent web sources:

       TypeScript 5.5 introduces:
       1. Inferred Type Predicates
       2. Control Flow Narrowing Improvements
       3. [More features...]

       Sources:
       - TypeScript Blog
       - GitHub Release Notes
       - Dev.to Articles
```

---

---

## Related

- [Integrations index](./index.md)
- [Configuration](../reference/configuration.md) — the full config file reference
- [Email & Calendar](./email-calendar.md)
