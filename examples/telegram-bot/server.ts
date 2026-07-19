/**
 * Telegram bridge for a Jazz agent.
 *
 * Two modes:
 *   bun server.ts             — long-polling (default): no public URL needed,
 *                               perfect for local models and quick testing.
 *   bun server.ts --webhook   — webhook server for production. Register it with
 *                               the Telegram API (see README).
 *
 * Env vars (see .env.example):
 *   TELEGRAM_BOT_TOKEN   token from @BotFather
 *   JAZZ_AGENT           agent id or name to run (default "telegram-assistant")
 *   WEBHOOK_SECRET       required in --webhook mode
 *   PORT                 webhook port (default 8787)
 */

const TOKEN = process.env["TELEGRAM_BOT_TOKEN"];
const AGENT = process.env["JAZZ_AGENT"] ?? "telegram-assistant";
const API = `https://api.telegram.org/bot${TOKEN}`;

// Telegram messages cap at 4096 chars.
const TELEGRAM_MESSAGE_LIMIT = 4000;

// Per-chat rolling history so the agent has conversation memory across
// one-shot `jazz run` calls. Swap for `--conversation tg-<chatId>` once the
// jazz run conversation flag is available.
const HISTORY_TURNS = 6;
const history = new Map<number, { role: "user" | "assistant"; text: string }[]>();

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number };
  };
}

function buildPrompt(chatId: number, text: string): string {
  const turns = history.get(chatId) ?? [];
  if (turns.length === 0) return text;
  const transcript = turns
    .map((turn) => `${turn.role === "user" ? "User" : "You"}: ${turn.text}`)
    .join("\n");
  return `Previous conversation:\n${transcript}\n\nUser: ${text}`;
}

function remember(chatId: number, role: "user" | "assistant", text: string): void {
  const turns = history.get(chatId) ?? [];
  turns.push({ role, text });
  history.set(chatId, turns.slice(-HISTORY_TURNS * 2));
}

async function runJazz(prompt: string): Promise<{ ok: boolean; answer?: string; error?: string }> {
  const proc = Bun.spawn(
    [
      "jazz",
      "run",
      "--agent",
      AGENT,
      "--json",
      "--approval-policy",
      "read-only",
      "--timeout",
      "120000",
    ],
    { stdin: new TextEncoder().encode(prompt), stdout: "pipe", stderr: "pipe" },
  );
  const raw = await new Response(proc.stdout).text();
  try {
    return JSON.parse(raw.trim());
  } catch {
    const stderr = await new Response(proc.stderr).text();
    return { ok: false, error: stderr.trim() || "jazz run produced no JSON output" };
  }
}

async function sendMessage(chatId: number, text: string): Promise<void> {
  for (let offset = 0; offset < text.length; offset += TELEGRAM_MESSAGE_LIMIT) {
    const chunk = text.slice(offset, offset + TELEGRAM_MESSAGE_LIMIT);
    const response = await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
    if (!response.ok) {
      console.error(`sendMessage failed: ${response.status} ${await response.text()}`);
    }
  }
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const text = update.message?.text;
  const chatId = update.message?.chat.id;
  if (!text || chatId === undefined) return;

  console.log(`[chat ${chatId}] ${text.slice(0, 80)}`);
  void fetch(`${API}/sendChatAction`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  });

  const result = await runJazz(buildPrompt(chatId, text));
  if (result.ok && result.answer) {
    remember(chatId, "user", text);
    remember(chatId, "assistant", result.answer);
    await sendMessage(chatId, result.answer);
  } else {
    console.error(`[chat ${chatId}] jazz run failed: ${result.error}`);
    await sendMessage(chatId, "Something went wrong on my side. Try again in a moment.");
  }
}

async function pollForever(): Promise<never> {
  console.log(`Long-polling as agent "${AGENT}" — press Ctrl+C to stop.`);
  let offset = 0;
  for (;;) {
    try {
      const response = await fetch(`${API}/getUpdates?timeout=50&offset=${offset}`, {
        signal: AbortSignal.timeout(60_000),
      });
      const body = (await response.json()) as { ok: boolean; result: TelegramUpdate[] };
      if (!body.ok) {
        console.error("getUpdates returned ok=false — check your token.");
        await Bun.sleep(5000);
        continue;
      }
      for (const update of body.result) {
        offset = Math.max(offset, update.update_id + 1);
        void handleUpdate(update);
      }
    } catch (error) {
      console.error(`poll error: ${String(error)}`);
      await Bun.sleep(5000);
    }
  }
}

function serveWebhook(): void {
  const secret = process.env["WEBHOOK_SECRET"];
  if (!secret) {
    throw new Error("WEBHOOK_SECRET is required in --webhook mode.");
  }
  const port = Number(process.env["PORT"] ?? 8787);
  Bun.serve({
    port,
    async fetch(req) {
      if (req.method !== "POST") return new Response("jazz telegram bridge");
      if (req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
        return new Response("forbidden", { status: 403 });
      }
      const update = (await req.json()) as TelegramUpdate;
      void handleUpdate(update);
      return new Response("ok");
    },
  });
  console.log(`Webhook server listening on :${port} as agent "${AGENT}".`);
}

if (!TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is required. Get one from @BotFather (see README).");
}

if (process.argv.includes("--webhook")) {
  serveWebhook();
} else {
  void pollForever();
}
