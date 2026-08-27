# `@jazz/bot-shared`

Small helpers shared by the two chat-bridge packages (`@jazz/telegram-bot`, `@jazz/discord-bot`)
so they can't drift apart on formatting/config rules that both bridges must apply identically.

Depends only on `@jazz/core`.

## Key files

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
