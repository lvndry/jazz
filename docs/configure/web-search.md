---
description: "Configure Brave, Exa, Linkup, Parallel, Perplexity, or Tavily as the Jazz web-search provider and understand normalized search options and limits."
---

# Configure web search

`web_search` discovers current public sources. It returns titles, URLs, snippets, optional publication dates, and provider metadata; it does not fetch the full page. Follow a result with `web_fetch` for readable web content or `http_request` for an API.

## Choose a provider

Jazz supports six search backends:

| Provider     | Identifier   | Environment variable |
| ------------ | ------------ | -------------------- |
| Brave Search | `brave`      | `BRAVE_API_KEY`      |
| Exa          | `exa`        | `EXA_API_KEY`        |
| Linkup       | `linkup`     | `LINKUP_API_KEY`     |
| Parallel     | `parallel`   | `PARALLEL_API_KEY`   |
| Perplexity   | `perplexity` | `PERPLEXITY_API_KEY` |
| Tavily       | `tavily`     | `TAVILY_API_KEY`     |

Provider pricing, indexes, and supported filters change independently of Jazz. Choose based on your workload and verify it with representative queries rather than relying on a permanent quality ranking in documentation.

## Configure globally

Set the provider and its key:

```bash
jazz config set web_search.provider brave
jazz config set web_search.brave.api_key
```

When the value is omitted, Jazz prompts without echoing the secret. The wizard stores it in the system keyring when one is available. In CI or containers, inject the matching environment variable instead.

Equivalent non-secret configuration:

```json
{
  "web_search": {
    "provider": "brave"
  }
}
```

## Override per agent

Set `config.webSearchProvider` in an agent definition when one agent should use a different backend:

```json
{
  "config": {
    "webSearchProvider": "exa"
  }
}
```

The agent-specific selection wins over `web_search.provider`; its key still resolves through Jazz secret storage or `EXA_API_KEY`.

## Search contract

The model may supply:

- `query`: required research goal, up to 5,000 characters;
- `searchQueries`: up to five short alternative phrases;
- `searchDepth`: `fast`, `standard`, or `deep`;
- `fromDate` and `toDate`: ISO dates in `YYYY-MM-DD` form;
- `sourceType`: `web`, `news`, `academic`, `company`, `people`, or `financial`;
- `maxResults`: 1–100, default 20.

These are normalized hints. Some providers ignore depth, date, source type, or alternative-query fields. A returned publication date may also be absent. Workflows that depend on recency must verify dates from the fetched source rather than assuming the search filter was enforced.

## Security and failure behavior

Search is classified read-only but sends the model's query to the configured provider. Do not put secrets or private document excerpts in a search query.

If no provider or key is configured, `web_search` returns an error to the agent. Jazz does not silently switch providers or invent results. Result volume is capped, and the agent should fetch and cite primary sources before treating snippets as evidence.

## Verify the setup

Start the intended agent and ask for a time-bounded search that requires current information:

```bash
jazz agent chat research-radar
```

```text
Find the three most recent official releases for Bun. Give me the release date and direct release URL for each. State when a date cannot be verified.
```

Confirm the agent invokes `web_search`, follows relevant results, and cites direct sources. The [weekly research radar](../guides/research-digest.md) shows a bounded scheduled workflow built on this contract.

See [Secrets and egress](../security/secrets-and-egress.md) for query disclosure and [Model providers](./providers.md) for the separate LLM configuration.
