import { CHOICE_CALLBACK_PREFIX, createChoiceTokens } from "@jazz/bot-shared/choice-tokens";
import {
  bold,
  code,
  codeBlock,
  line,
  markdown,
  plainLine,
  quote,
  text,
} from "@jazz/bot-shared/surface";
import { fakeFetch } from "@jazz/core/test-support/fakes";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createTelegramSurface,
  renderRichText,
  type TelegramSurface,
  telegramPieces,
} from "./surface";
import { resetTelegramDispatchState } from "./telegram-dispatch";

describe("renderRichText", () => {
  test("maps spans onto Telegram's HTML flavour", () => {
    expect(renderRichText([line(bold("Working"), text(" — "), code("web_search"))])).toBe(
      "<b>Working</b> — <code>web_search</code>",
    );
  });

  test("escapes text so model prose cannot forge a tag", () => {
    expect(renderRichText([plainLine('<script>alert("x")</script>')])).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
  });

  test("escapes inside a code span too, where markup is most likely", () => {
    expect(renderRichText([line(code("rm -rf <dir> && echo 'done'"))])).toBe(
      "<code>rm -rf &lt;dir&gt; &amp;&amp; echo &#039;done&#039;</code>",
    );
  });

  test("renders a code block as pre", () => {
    expect(renderRichText([codeBlock("a < b")])).toBe("<pre><code>a &lt; b</code></pre>");
  });

  test("uses the collapsible quote only when one was asked for", () => {
    expect(renderRichText([quote("thinking", true)])).toContain("expandable");
    expect(renderRichText([quote("thinking", false)])).toBe("<blockquote>thinking</blockquote>");
  });
});

describe("choice tokens", () => {
  test("a minted token reads back as the prompt and option it stood for", () => {
    const tokens = createChoiceTokens();
    const data = tokens.mint({ promptId: "call_abc123", choiceId: "approve" });
    expect(tokens.read(data)).toEqual({ promptId: "call_abc123", choiceId: "approve" });
  });

  test("two prompts with identical options stay distinguishable", () => {
    const tokens = createChoiceTokens();
    const first = tokens.mint({ promptId: "tc1", choiceId: "approve" });
    const second = tokens.mint({ promptId: "tc2", choiceId: "approve" });
    expect(first).not.toBe(second);
    expect(tokens.read(first)?.promptId).toBe("tc1");
    expect(tokens.read(second)?.promptId).toBe("tc2");
  });

  test("stays inside Telegram's 64-byte callback_data limit for a long prompt id", () => {
    const tokens = createChoiceTokens();
    const data = tokens.mint({
      promptId: "call_0123456789abcdef0123456789abcdef0123456789",
      choiceId: "approve",
    });
    expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
  });

  test("refuses callback data belonging to another handler", () => {
    const tokens = createChoiceTokens();
    expect(tokens.read("md:safe")).toBeUndefined();
    expect(tokens.read("")).toBeUndefined();
    expect(tokens.read(CHOICE_CALLBACK_PREFIX)).toBeUndefined();
  });

  test("refuses a token it never minted", () => {
    expect(createChoiceTokens().read(`${CHOICE_CALLBACK_PREFIX}:zzz`)).toBeUndefined();
  });

  test("evicts the oldest rather than growing without bound", () => {
    const tokens = createChoiceTokens(2);
    const first = tokens.mint({ promptId: "tc1", choiceId: "approve" });
    const second = tokens.mint({ promptId: "tc2", choiceId: "approve" });
    const third = tokens.mint({ promptId: "tc3", choiceId: "approve" });

    expect(tokens.size).toBe(2);
    expect(tokens.read(first)).toBeUndefined();
    expect(tokens.read(second)?.promptId).toBe("tc2");
    expect(tokens.read(third)?.promptId).toBe("tc3");
  });
});

describe("telegramPieces", () => {
  test("a short answer and its trailer go out as one message", () => {
    const pieces = telegramPieces([markdown("**Done** it"), plainLine(""), plainLine("$0.01")]);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.html).toBe("<b>Done</b> it\n\n$0.01");
  });

  test("a long answer is split as Markdown, so no piece cuts a tag in half", () => {
    const paragraph = `${"**word** ".repeat(40)}\n`;
    const pieces = telegramPieces([markdown(paragraph.repeat(40))]);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      // Telegram's hard limit; the splitter cuts Markdown lower to leave room for tags.
      expect(piece.html.length).toBeLessThanOrEqual(4_096);
      const opened = piece.html.match(/<b>/g)?.length ?? 0;
      const closed = piece.html.match(/<\/b>/g)?.length ?? 0;
      expect(opened).toBe(closed);
    }
  });

  test("keeps the plain words beside each piece for a rendering fallback", () => {
    const pieces = telegramPieces([markdown("**bold**")]);
    expect(pieces[0]?.plain).toBe("**bold**");
  });
});

describe("topics", () => {
  const realFetch = globalThis.fetch;
  let requests: { method: string; payload: Record<string, unknown> }[];

  beforeEach(() => {
    requests = [];
    globalThis.fetch = fakeFetch((url: string, init: { body: string | FormData }) => {
      const method = url.slice(url.lastIndexOf("/") + 1);
      const payload =
        typeof init.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : Object.fromEntries(
              [...init.body.entries()].filter((entry) => typeof entry[1] === "string"),
            );
      requests.push({ method, payload });
      return Promise.resolve(Response.json({ ok: true, result: { message_id: 31 } }));
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const surface = () => createTelegramSurface({ botToken: "123:test", apiBase: "http://bot.test" });
  const only = (method: string) => requests.find((request) => request.method === method)?.payload;

  test("a message, a typing hint and a file all land in the topic", async () => {
    const telegram = surface();
    await telegram.send("-100500_42", { body: [plainLine("hello")] });
    await telegram.typing?.("-100500_42");
    await telegram.sendFile?.("-100500_42", {
      path: "/tmp/chart.png",
      bytes: new Uint8Array([1, 2, 3]),
      filename: "chart.png",
    });

    expect(only("sendMessage")).toMatchObject({ chat_id: -100500, message_thread_id: 42 });
    expect(only("sendChatAction")).toMatchObject({ chat_id: -100500, message_thread_id: 42 });
    expect(only("sendPhoto")).toMatchObject({ chat_id: "-100500", message_thread_id: "42" });
  });

  test("a chat without topics is addressed by its id alone", async () => {
    await surface().send("1001", { body: [plainLine("hello")] });
    expect(only("sendMessage")).toMatchObject({ chat_id: 1001 });
    expect(only("sendMessage")).not.toHaveProperty("message_thread_id");
  });

  test("a draft goes to the topic, offers stop, and starts as the thinking placeholder", async () => {
    const outcome = await surface().streamDraft("1001_9", { id: 77, body: [], stoppable: true });

    expect(outcome).toBe("shown");
    expect(only("sendMessageDraft")).toEqual({
      chat_id: 1001,
      message_thread_id: 9,
      draft_id: 77,
      can_stop: true,
      text: "",
    });
  });

  test("buttons are coloured by intent, and a disabled one carries no action", async () => {
    await surface().send("1001", {
      body: [plainLine("Run it?")],
      promptId: "call-1",
      choices: [
        { id: "approve", label: "✅ Approve", intent: "primary" },
        { id: "reject", label: "❌ Reject", intent: "danger" },
        { id: "later", label: "Later" },
        { id: "picked", label: "✅ Approve", disabled: true },
      ],
    });
    const keyboard = (
      only("sendMessage")?.["reply_markup"] as {
        inline_keyboard: Record<string, unknown>[][];
      }
    ).inline_keyboard.flat();

    expect(keyboard[0]).toMatchObject({ style: "success" });
    expect(keyboard[1]).toMatchObject({ style: "danger" });
    expect(keyboard[2]).not.toHaveProperty("style");
    expect(keyboard[3]).toEqual({ text: "✅ Approve", disabled: {} });
  });

  test("a message is marked as seen with a reaction on the message itself", async () => {
    await surface().acknowledge("1001_9", "42");
    expect(only("setMessageReaction")).toEqual({
      chat_id: 1001,
      message_id: 42,
      reaction: [{ type: "emoji", emoji: "👀" }],
    });
  });

  test("editing and re-drawing buttons address the message, not the topic", async () => {
    const telegram = surface();
    await telegram.edit?.("-100500_42", "31", { body: [plainLine("done")] });
    await telegram.setChoices("-100500_42", "31", []);

    expect(only("editMessageText")).toMatchObject({ chat_id: -100500, message_id: 31 });
    expect(only("editMessageText")).not.toHaveProperty("message_thread_id");
    expect(only("editMessageReplyMarkup")).toMatchObject({ chat_id: -100500, message_id: 31 });
  });
});

describe("streamDraft and rich messages", () => {
  const realFetch = globalThis.fetch;
  let requests: Record<string, unknown>[];
  let methods: string[];

  /** Answer each request with the next of `replies`, the last one repeating. */
  const replyWith = (...replies: Record<string, unknown>[]): void => {
    globalThis.fetch = fakeFetch((url: string, init: { body: string }) => {
      methods.push(url.slice(url.lastIndexOf("/") + 1));
      requests.push(JSON.parse(init.body) as Record<string, unknown>);
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)] ?? { ok: true };
      return Promise.resolve(Response.json(reply, { status: reply["ok"] === true ? 200 : 400 }));
    });
  };

  beforeEach(() => {
    requests = [];
    methods = [];
    resetTelegramDispatchState();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const telegram = () =>
    createTelegramSurface({ botToken: "123:test", apiBase: "http://bot.test" });
  const draft = (body: Parameters<TelegramSurface["streamDraft"]>[1]["body"]) =>
    telegram().streamDraft("1001", { id: 5, body, stoppable: false });

  const sent = { ok: true, result: { message_id: 8 } };
  const malformed = { ok: false, error_code: 400, description: "can't parse rich message" };
  const unknownMethod = { ok: false, error_code: 404, description: "Not Found" };

  test("an answer's draft is a rich draft of the Markdown itself", async () => {
    replyWith({ ok: true, result: true });
    expect(await draft([markdown("| a | b |\n|---|---|\n| 1 | 2 |")])).toBe("shown");
    expect(methods).toEqual(["sendRichMessageDraft"]);
    expect(requests[0]).toMatchObject({
      draft_id: 5,
      rich_message: { markdown: "| a | b |\n|---|---|\n| 1 | 2 |" },
    });
    expect(requests[0]).not.toHaveProperty("can_stop");
  });

  test("a refused rich draft is drawn as HTML, then as plain words", async () => {
    replyWith(malformed, malformed, { ok: true, result: true });
    expect(await draft([markdown("**bold**")])).toBe("shown");
    expect(methods).toEqual(["sendRichMessageDraft", "sendMessageDraft", "sendMessageDraft"]);
    expect(requests[1]).toMatchObject({ text: "<b>bold</b>", parse_mode: "HTML" });
    expect(requests[2]).toMatchObject({ text: "**bold**" });
    expect(requests[2]).not.toHaveProperty("parse_mode");
  });

  test("progress with no prose is drafted as HTML", async () => {
    replyWith({ ok: true, result: true });
    await draft([line(bold("🤔 Working…"))]);
    expect(methods).toEqual(["sendMessageDraft"]);
  });

  test("an answer goes out as one rich message with its buttons and reply", async () => {
    replyWith(sent);
    const ref = await telegram().send("1001_9", {
      body: [markdown("Total: $5"), plainLine(""), line(bold("✅ Done"), text(" · $0.0100"))],
      choices: [{ id: "more", label: "🔍 Go deeper" }],
      promptId: "followup",
      replyTo: "3",
    });

    expect(ref).toBe("8");
    expect(methods).toEqual(["sendRichMessage"]);
    expect(requests[0]).toMatchObject({
      chat_id: 1001,
      message_thread_id: 9,
      rich_message: { markdown: "Total: \\$5\n\n**✅ Done** · \\$0\\.0100" },
      reply_parameters: { message_id: 3 },
    });
    expect(requests[0]).toHaveProperty("reply_markup");
    expect(requests[0]).not.toHaveProperty("parse_mode");
  });

  test("a refused rich message is sent as HTML instead", async () => {
    replyWith(malformed, sent);
    expect(await telegram().send("1001", { body: [markdown("**bold**")] })).toBe("8");
    expect(methods).toEqual(["sendRichMessage", "sendMessage"]);
    expect(requests[1]).toMatchObject({ text: "<b>bold</b>", parse_mode: "HTML" });
  });

  test("a server without rich messages is only asked once", async () => {
    replyWith(unknownMethod, sent, sent);
    const surface = telegram();
    await surface.send("1001", { body: [markdown("one")] });
    await surface.send("1001", { body: [markdown("two")] });
    expect(methods).toEqual(["sendRichMessage", "sendMessage", "sendMessage"]);
  });

  test("bridge text with no prose keeps the HTML path", async () => {
    replyWith(sent);
    await telegram().send("1001", { body: [plainLine("⏹ Cancelled")] });
    expect(methods).toEqual(["sendMessage"]);
  });

  test("an answer past the rich limit is split and sent as HTML", async () => {
    replyWith(sent);
    await telegram().send("1001", { body: [markdown("word ".repeat(7_000))] });
    expect(methods.every((method) => method === "sendMessage")).toBe(true);
    expect(methods.length).toBeGreaterThan(1);
  });

  test("a draft Telegram turns down is reported as refused", async () => {
    replyWith({ ok: false, error_code: 404, description: "Not Found" });
    expect(await draft([])).toBe("refused");
  });

  test("a rate-limited frame is skipped, not reported as refused", async () => {
    replyWith({ ok: false, error_code: 429, parameters: { retry_after: 1 } });
    expect(await draft([markdown("hi")])).toBe("skipped");
  });

  test("a server error is skipped, not taken as Telegram refusing drafts", async () => {
    replyWith({ ok: false, error_code: 502, description: "Bad Gateway" });
    expect(await draft([])).toBe("skipped");
  });

  test("a long answer's HTML draft renders only its tail, cut at a paragraph", async () => {
    replyWith(unknownMethod, { ok: true, result: true });
    const early = `${"early words ".repeat(400)}`;
    const late = "the latest paragraph";
    await draft([markdown(`${early}\n\n${"middle ".repeat(400)}\n\n${late}`)]);
    expect(methods).toEqual(["sendRichMessageDraft", "sendMessageDraft"]);
    const shown = String(requests[1]?.["text"]);
    expect(shown.endsWith(late)).toBe(true);
    expect(shown).not.toContain("early words");
  });
});
