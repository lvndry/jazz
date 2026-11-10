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
    const shown = await surface().streamDraft("1001_9", { id: 77, body: [], stoppable: true });

    expect(shown).toBe(true);
    expect(only("sendMessageDraft")).toEqual({
      chat_id: 1001,
      message_thread_id: 9,
      draft_id: 77,
      can_stop: true,
      text: "",
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

describe("streamDraft", () => {
  const realFetch = globalThis.fetch;
  let requests: Record<string, unknown>[];

  /** Answer each request with the next of `replies`, the last one repeating. */
  const replyWith = (...replies: Record<string, unknown>[]): void => {
    globalThis.fetch = fakeFetch((_url: string, init: { body: string }) => {
      requests.push(JSON.parse(init.body) as Record<string, unknown>);
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)] ?? { ok: true };
      return Promise.resolve(Response.json(reply, { status: reply["ok"] === true ? 200 : 400 }));
    });
  };

  beforeEach(() => {
    requests = [];
    resetTelegramDispatchState();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const draft = (body: Parameters<TelegramSurface["streamDraft"]>[1]["body"]) =>
    createTelegramSurface({ botToken: "123:test", apiBase: "http://bot.test" }).streamDraft(
      "1001",
      { id: 5, body, stoppable: false },
    );

  test("shows the answer as HTML", async () => {
    replyWith({ ok: true, result: true });
    expect(await draft([markdown("**bold**")])).toBe(true);
    expect(requests[0]).toMatchObject({ text: "<b>bold</b>", parse_mode: "HTML" });
    expect(requests[0]).not.toHaveProperty("can_stop");
  });

  test("markup Telegram rejects is shown again as plain words", async () => {
    replyWith({ ok: false, error_code: 400, description: "can't parse entities" }, { ok: true });
    expect(await draft([markdown("**bold**")])).toBe(true);
    expect(requests[1]).toMatchObject({ text: "**bold**" });
    expect(requests[1]).not.toHaveProperty("parse_mode");
  });

  test("a draft Telegram turns down is reported as refused", async () => {
    replyWith({ ok: false, error_code: 404, description: "Not Found" });
    expect(await draft([])).toBe(false);
  });

  test("a rate-limited frame is skipped, not reported as refused", async () => {
    replyWith({ ok: false, error_code: 429, parameters: { retry_after: 1 } });
    expect(await draft([markdown("hi")])).toBe(true);
  });
});
