---
description: "Configure Brave, Exa, Keenable, Linkup, Parallel, Perplexity, Tavily, or treg for web search, set their fallback order, and understand search options and limits."
---

# Configure web search

`web_search` discovers current public sources. It returns titles, URLs, snippets, optional publication dates, and provider metadata; it does not fetch the full page. Follow a result with `web_fetch` for readable web content or `http_request` for an API.

## Choose a provider

Jazz supports eight search backends:

| Provider     | Identifier   | Environment variable |
| ------------ | ------------ | -------------------- |
| Brave Search | `brave`      | `BRAVE_API_KEY`      |
| Exa          | `exa`        | `EXA_API_KEY`        |
| Keenable     | `keenable`   | `KEENABLE_API_KEY`   |
| Linkup       | `linkup`     | `LINKUP_API_KEY`     |
| Parallel     | `parallel`   | `PARALLEL_API_KEY`   |
| Perplexity   | `perplexity` | `PERPLEXITY_API_KEY` |
| Tavily       | `tavily`     | `TAVILY_API_KEY`     |
| treg         | `treg`       | `TREG_TOKEN`         |

Configure a key for every provider you have an account with. More than one key gives agents somewhere to go when a provider fails.

## Configure keys

```bash
jazz config set web_search.brave.api_key
jazz config set web_search.exa.api_key
```

When the value is omitted, Jazz prompts without echoing the secret. The wizard stores it in the system keyring when one is available. In CI or containers, inject the matching environment variable instead.

With keys and no other setting, agents search with every provider that has a key, in this order: exa, parallel, tavily, brave, perplexity, linkup, treg, keenable.

## Set the fallback order

`web_search.providers` lists the providers to use, first choice first:

```bash
jazz config set web_search.providers brave,exa
```

```json
{
  "web_search": {
    "providers": ["brave", "exa"]
  }
}
```

The list is authoritative: a provider left off it is never called, even with a key. Providers on it without a key are skipped. An empty list (`jazz config set web_search.providers ""`) turns external search off and uses the model's built-in search when the model provider hosts one. Remove the setting to go back to every provider with a key.

Settings → Web Search in the `jazz` menu and the agent wizards set the same order: pick the first provider, then tick the ones to fall back to.

## Prefer built-in search where the model has it

Some model providers host their own search (OpenAI, ChatGPT, Anthropic, Google, xAI, Groq and OpenRouter); others, such as vLLM and Ollama, do not. To use built-in search where it exists and your provider order everywhere else:

```bash
jazz config set web_search.providers exa,brave,linkup,parallel
jazz config set web_search.preferBuiltin true
```

An agent on an OpenAI model then searches with OpenAI's built-in search, and an agent on a vLLM model searches with Exa, falling back to Brave, Linkup and Parallel. The built-in search runs on the model provider's account, so it has no separate quota to fall back from. The setting applies only to agents without their own `webSearchProviders`. Toggle it in Settings → Web Search.

## Fallback behavior

Each search tries the providers in order and returns the first answer. Any failure moves to the next provider: quota or credit exhaustion, rate limits, a refused key, timeouts, server errors, and requests one provider rejects. An empty result is an answer, not a failure.

Quota, rate-limit and key errors are not retried against the same provider; they go straight to the next one. Server errors and timeouts are retried up to three times first.

A provider that ran out of quota or had its key refused moves to the back of the order for an hour; a rate-limited one for a minute. It is still tried if every other provider also fails. This memory lasts for the process, so a long chat, the daemon, or a bot does not rediscover an exhausted quota on every search.

When a fallback happened, the result names the providers that failed and why, so the agent and the tool summary can say which provider answered. If every provider fails, the error lists each one's failure.

## When no key is configured

An agent with no provider key and no built-in model search does not get `web_search` at all, so the model never spends a call on a guaranteed failure. `/info` shows `web search  no API key` with the command to run. A key you add mid-conversation takes effect on the next message, which also changes the tool list once.

## Override per agent

Set `config.webSearchProviders` in an agent definition when one agent should use a different order:

```json
{
  "config": {
    "webSearchProviders": ["exa", "tavily"]
  }
}
```

The agent's list replaces `web_search.providers` for that agent and follows the same rules: `[]` selects the model's built-in search, and keys still resolve through Jazz secret storage or the provider's environment variable. `/tools` shows the order an agent will use, for example `web_search  via Exa → Tavily`.

## treg: free first, paid fallback

Add `treg` to the order and provide a [treg token](https://treg.to) using `jazz config set web_search.treg.api_key` or `TREG_TOKEN`. Each search calls TinyFish's free endpoint directly. If it errors or finds no results, Jazz tries the routed endpoint once, excluding TinyFish, with a **$0.05 treg-metered cost cap per fallback call**. Owned provider keys can incur upstream charges outside treg's cap. A failed or over-cap fallback returns an error; it does not retry. Other agents' providers are unchanged.

TinyFish receives `query` and date hints; routed fallback uses only `query` and `maxResults`. Depth, source-type, and alternative-query hints are not enforced, and fallback cannot guarantee date filtering. Check [treg's catalog](https://treg.to/app#platform/web/search) for current routes and prices.

Routed results keep their provider's source text: Jazz uses a snippet when present, otherwise content or joined excerpts/highlights. Publication dates may come from `date` or `publish_date`; an absent or unrecognized date is omitted.

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

Search is classified read-only but sends the model's query to the configured provider, and on a fallback to each provider tried after it. Only providers you gave a key to, and that are on the order when you set one, ever receive a query. Do not put secrets or private document excerpts in a search query.

If no provider has a key, `web_search` returns an error to the agent. Jazz never invents results. Within its own backend, `treg` also tries TinyFish first, then a capped paid treg route on failure or empty results. Result volume is capped, and the agent should fetch and cite primary sources before treating snippets as evidence.

## Verify the setup

Start the intended agent and ask for a time-bounded search that requires current information:

```bash
jazz agent chat <agent-name>
```

```text
Find the three most recent official releases for Bun. Give me the release date and direct release URL for each. State when a date cannot be verified.
```

Confirm the agent invokes `web_search`, follows relevant results, and cites direct sources. The [weekly research radar](../guides/research-digest.md) shows a bounded scheduled workflow built on this contract.

See [Secrets and egress](../security/secrets-and-egress.md) for query disclosure and [Model providers](./providers.md) for the separate LLM configuration.
