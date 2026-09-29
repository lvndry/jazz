---
description: "Every network request Jazz makes on its own, apart from your model and the tools an agent calls: what triggers it, what it sends, and how to turn it off."
---

# What Jazz sends on its own

Jazz has no account, no analytics and no crash reporting. Apart from the requests your model
provider needs and the tools an agent calls, it makes the requests below, and nothing else.
None of them carries your prompts, conversations, files or memory.

| Request                      | When                                                                                               | What is sent                                                                                                              | Turn it off                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Update check                 | At most once every 3 days, when a command starts. Never in `jazz run`.                             | `GET https://registry.npmjs.org/jazz-ai`, with no identifiers.                                                            | `JAZZ_DISABLE_UPDATE_CHECK=1` or `JAZZ_OFFLINE=1`                               |
| Model catalog                | Once per process that needs model metadata, including local models.                                | `GET https://models.dev/api.json`. The last copy is kept in `~/.jazz/cache/models-dev.json`.                              | `JAZZ_OFFLINE=1` (reads the cached copy), or `JAZZ_MODELS_DEV_URL` for a mirror |
| Provider model lists         | Creating or editing an agent, and the first model request of each run.                             | `GET` of the provider's model list, with your key for that provider.                                                      | Use a local provider                                                            |
| Library index                | `jazz persona`, `jazz workflow` and `jazz skill` `browse`, `search` and `add`. Cached for 6 hours. | `GET https://jazz-cli.vercel.app/library/<collection>.json`.                                                              | `JAZZ_OFFLINE=1`, or `JAZZ_LIBRARY_URL` for a mirror                            |
| Library download             | Installing a persona, workflow or skill.                                                           | `GET` of that entry from the same library.                                                                                | `JAZZ_OFFLINE=1` refuses the install                                            |
| Plugin catalog and downloads | `jazz plugin add` and `jazz plugin update`.                                                        | `GET` of the catalog entry and the plugin's source or artifact.                                                           | Do not install plugins; `JAZZ_OFFLINE` does not apply                           |
| Updating Jazz                | `jazz update` only.                                                                                | `GET https://api.github.com/repos/lvndry/jazz/releases`, then the release binary, or your package manager's own requests. | Do not run it                                                                   |
| ChatGPT sign-in              | Signing in, and when the token needs refreshing.                                                   | OpenAI's OAuth endpoints at `auth.openai.com`.                                                                            | Use the `openai` provider with an API key                                       |
| MCP servers                  | Run start, for the enabled servers the agent uses, and `jazz agent create`.                        | Whatever the server's protocol needs, to the URL you configured. Local `stdio` servers make no request.                   | Disable or remove the server                                                    |
| OTLP telemetry               | Only when an endpoint is set in `telemetry.otlp` or `OTEL_EXPORTER_OTLP_ENDPOINT`.                 | Run, model, tool and process events: names, counts, durations, token usage and cost. No prompt, completion or tool text.  | Leave the endpoint unset, or set `telemetry.otlp.enabled` to `false`            |

Local telemetry is written to `~/.jazz/telemetry` and never leaves the machine on its own.
Desktop notifications are written to the terminal Jazz runs in, or shown by the operating
system (`terminal-notifier` on macOS, `notify-send` on Linux), and send nothing over the
network. Over SSH, a terminal notification reaches your local terminal through the SSH
session.

## What `JAZZ_OFFLINE` covers

`JAZZ_OFFLINE=1` stops the update check, the model catalog and the library. It does not stop
model requests, provider model lists, plugin installs, `jazz update`, MCP servers, OTLP
export, or anything an agent's tools do. [Local and air-gapped models](../getting-started/local-models.md#what-jazz_offline-does-and-does-not-do)
covers running with no network.

## The daemon, peers and webhooks

`jazz daemon` listens on `127.0.0.1:4747` by default and makes no request of its own, except
posting progress to a URL a caller supplied with its request. Accepting a peer invite
(`jazz peers invite accept <url>`) contacts that invite's address once. After that, your
agent contacts a peer only when it asks one a question. See
[Agent-to-agent](../concepts/agent-to-agent.md) and [Surface access](./surface-access.md).

## Chat bots

A chat bridge talks to its platform (Telegram, Discord, WhatsApp, Photon, or Messages on your
Mac) to receive and send messages. The Telegram bridge also looks up place names you share
with OpenStreetMap's Nominatim service; set `NOMINATIM_BASE_URL` to another geocoder, or to
an empty value to turn it off.

## Related

- [Secrets and egress](./secrets-and-egress.md): what an agent's own tools can reach, and how to limit it.
- [Environment variables](../configure/environment-variables.md): every switch above.
- [Observability](../configure/observability.md): OTLP export in detail.
