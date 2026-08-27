# `@jazz/bot-shared`

Small helpers shared by the two chat-bridge packages (`@jazz/telegram-bot`, `@jazz/discord-bot`)
so they can't drift apart on formatting/config rules that both bridges must apply identically.

Depends on `@jazz/core` and `@jazz/adapters` (for `PersonaServiceImpl`).

## Key files

- **`agent-file.ts`** — the per-conversation agent file format (`AgentFile`/`AgentConfig`) and
  its read/write/clone/rename lifecycle. Both bridges give every conversation its own agent JSON
  cloned from a seeded template; only the id scheme (`dc_<channel>` vs `tg_<chat>`) stays in each
  bridge's own `agents.ts`, since the two schemes must never collide.
- **`personas.ts`** — `/persona` picker discovery, via `@jazz/adapters`'s `PersonaServiceImpl` rather than
  each bridge scanning persona directories by hand.
- **`session-store.ts`** — per-conversation epoch/incognito state (`/new`, `/incognito`).
- **`timezone-store.ts`** — per-conversation IANA zone resolution and `/tz`.
- **`usage-store.ts`** — daily runs/tokens/cost aggregation for `/status` and the daily spend cap.
- **`scoped-record-store.ts`** — the corrupt-tolerant JSON-record-file primitive the three stores above
  share.
- **`ollama.ts`** — `listOllamaModels`/`modelSupportsThinking`, used to build the `/model` picker
  against a local Ollama server. Ollama is the only provider the bridges can introspect for free;
  any other provider Jazz supports is set via an explicit `/model provider/model` argument instead
  (validated against `@jazz/core`'s provider registry, with reasoning support looked up from the
  models.dev catalog via `getModelsDevMetadata`).
- **`reasoning.ts`** — rules for surfacing a run's model reasoning in a chat bridge. Both bridges
  consume the same `thinking_chunk` stream and face the same two conflicting needs: a live
  progress bubble that must stay one line (edited in place under a platform edit rate limit) and
  a post-run record that keeps everything the model actually thought.
- **`bridge-config.ts`** — the merge rule for a bridge's `config.json`: which keys the bridge
  owns, and what happens when their backing environment variables go away. Kept pure and
  filesystem-free so it's testable without touching disk.
- **`write-bridge-config.ts`** — the entrypoint script (`bun write-bridge-config.ts
  <path-to-config.json>`) that applies `bridge-config.ts`'s merge rule to a real file, run at
  container startup. Merges rather than overwrites, since the data volume outlives the container
  and anything an operator added by hand must survive a restart.
- **`run-log.ts`** — per-turn NDJSON record of what a bridge run did, written to
  `<dataDir>/logs/runs/`. The conversation transcript is only written once a run completes, so a
  run that hangs or times out would otherwise leave no trace to diagnose.

## Related documentation

- **Telegram bridge**: `packages/telegram-bot/README.md`
- **Discord bridge**: `packages/discord-bot/README.md`
- **Core**: `packages/core/README.md`
