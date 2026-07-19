# Telegram Bot — Jazz Agent Bridge

Turn any Jazz agent into a Telegram bot. Works with local models (Ollama) — the
whole loop runs on your machine except the Telegram API itself.

```
Telegram → this bridge → jazz run --json → reply
```

Two modes:

- **Long-polling (default)** — no public URL, no tunnel, works from your laptop.
- **Webhook** — for production deployments with a public HTTPS endpoint.

## 1. Get a bot token

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Pick a display name (e.g. `Jazz Assistant`), then a username ending in `bot`
   (e.g. `my_jazz_assistant_bot`).
4. BotFather replies with the token — a string like
   `7123456789:AAH8x…`. That is your `TELEGRAM_BOT_TOKEN`.

Keep it secret; anyone with the token controls the bot. You can revoke and
regenerate it anytime with `/revoke` in BotFather.

## 2. Create the agent

```bash
jazz agent create
```

Suggested answers for a bot that is safe to expose:

- Name: `telegram-assistant`
- Provider: any — pick **Ollama** to keep inference fully local
- Tools: keep it minimal (web search + read-only tools); avoid shell/file-write
  tools on an internet-facing bot
- Reasoning: `low` or `medium` (Telegram users expect fast replies)

The bridge also runs with `--approval-policy read-only`, so even a
misconfigured agent cannot execute writes or shell commands unattended.

## 3. Run it (long-polling — zero infrastructure)

```bash
cd examples/telegram-bot
cp .env.example .env         # fill in TELEGRAM_BOT_TOKEN
bun --env-file=.env server.ts
```

Message your bot on Telegram. Done.

## 4. Production (webhook mode)

Deploy anywhere that gives you public HTTPS (Railway, Fly, a VPS) or tunnel
from your own machine (`cloudflared tunnel --url http://localhost:8787`).

```bash
WEBHOOK_SECRET=$(openssl rand -hex 16)
bun --env-file=.env server.ts --webhook
```

Register the webhook once:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://your-host.example.com/" \
  -d "secret_token=$WEBHOOK_SECRET"
```

Telegram sends the secret with every update; the bridge rejects anything
without it. To go back to polling: `curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/deleteWebhook"`.

## How it works

- The incoming message text is piped to `jazz run --agent <agent> --json` on
  **stdin** — never interpolated into a shell string, so hostile message
  content cannot inject commands.
- The bridge keeps a small rolling history per chat (last 6 turns) and
  prepends it to the prompt, giving the agent conversation memory across
  one-shot runs.
- Replies longer than Telegram's 4096-character limit are chunked.
- A `typing…` indicator shows while the agent works.

## Notes

- Cost: every message is one `jazz run`; the JSON envelope includes `costUSD`
  if you want to log spend per chat.
- Group chats: give the bot privacy mode OFF in BotFather (`/setprivacy`) if
  you want it to see all group messages, or keep it ON and mention the bot.
- WhatsApp: the same bridge shape works — swap the Telegram API calls for
  Twilio's WhatsApp sandbox (simplest) or Meta's WhatsApp Business Cloud API.
