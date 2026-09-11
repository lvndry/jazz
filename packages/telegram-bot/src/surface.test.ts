import { bold, code, codeBlock, line, plainLine, quote, text } from "@jazz/bot-shared/surface";
import { describe, expect, test } from "bun:test";
import { CHOICE_CALLBACK_PREFIX, createChoiceTokens, renderRichText } from "./surface";

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
