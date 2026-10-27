import { describe, expect, it } from "bun:test";
import { generationPromptOpensBlock, TagPairParser, TagPairParserFactory } from "./tag-pair-parser";

describe("TagPairParser", () => {
  it("passes plain text through as visibleText", () => {
    const parser = new TagPairParser();
    const out = parser.feed("hello world");
    expect(out.visibleText).toBe("hello world");
    expect(out.thinkingText).toBe("");
    expect(out.thinkingStarted).toBeUndefined();
    expect(out.thinkingEnded).toBeUndefined();
  });

  it("splits a single complete <think>...</think> block in one feed", () => {
    const parser = new TagPairParser();
    const out = parser.feed("<think>secret</think>after");
    expect(out.visibleText).toBe("after");
    expect(out.thinkingText).toBe("secret");
    expect(out.thinkingStarted).toBe(true);
    expect(out.thinkingEnded).toBe(true);
  });

  it("opens a block after leading whitespace", () => {
    const parser = new TagPairParser();
    const out = parser.feed("\n <think>secret</think>after");
    expect(out.visibleText).toBe("\n after");
    expect(out.thinkingText).toBe("secret");
  });

  it("stitches an open tag split across two feeds", () => {
    const parser = new TagPairParser();
    const a = parser.feed("<thi");
    const b = parser.feed("nk>secret</think>after");
    expect(a.visibleText).toBe("");
    expect(a.thinkingText).toBe("");
    expect(a.thinkingStarted).toBeUndefined();

    expect(b.visibleText).toBe("after");
    expect(b.thinkingText).toBe("secret");
    expect(b.thinkingStarted).toBe(true);
    expect(b.thinkingEnded).toBe(true);
  });

  it("stitches a close tag split across two feeds", () => {
    const parser = new TagPairParser();
    const a = parser.feed("<think>secr");
    const b = parser.feed("et</thi");
    const c = parser.feed("nk>after");
    expect(a.thinkingStarted).toBe(true);
    expect(a.thinkingText).toBe("secr");
    expect(b.thinkingText).toBe("et");
    expect(c.thinkingEnded).toBe(true);
    expect(c.visibleText).toBe("after");
  });

  it("treats <table> and other non-reasoning tags as visible text", () => {
    const parser = new TagPairParser();
    const out = parser.feed("<table>row</table>b");
    expect(out.visibleText).toBe("<table>row</table>b");
    expect(out.thinkingText).toBe("");
    expect(out.thinkingStarted).toBeUndefined();
  });

  it("emits an unmatched lone < as visible text", () => {
    const parser = new TagPairParser();
    const out = parser.feed("2 < 3 is true");
    expect(out.visibleText).toBe("2 < 3 is true");
  });

  it("keeps a tag the answer quotes once it has started", () => {
    const parser = new TagPairParser();
    const answer = 'The regex `\\A(?:\\s*<think>)?.*?</think>` strips up to the first "</think>".';
    const out = parser.feed(answer);
    expect(out.visibleText).toBe(answer);
    expect(out.thinkingText).toBe("");
    expect(out.thinkingStarted).toBeUndefined();
  });

  it("keeps an unclosed tag the answer quotes, and the text after it", () => {
    const parser = new TagPairParser();
    const a = parser.feed("Models open reasoning with <thi");
    const b = parser.feed("nk> and the rest of this answer");
    const c = parser.flush();
    expect(a.visibleText + b.visibleText + c.visibleText).toBe(
      "Models open reasoning with <think> and the rest of this answer",
    );
    expect(a.thinkingText + b.thinkingText + c.thinkingText).toBe("");
  });

  it("keeps a tag that follows a reasoning block and the answer", () => {
    const parser = new TagPairParser();
    const out = parser.feed("<think>plan</think>Use `<think>` tags.");
    expect(out.visibleText).toBe("Use `<think>` tags.");
    expect(out.thinkingText).toBe("plan");
  });

  it("suppresses thinking events for an empty <think></think> block", () => {
    const parser = new TagPairParser();
    const out = parser.feed("<think></think>b");
    expect(out.visibleText).toBe("b");
    expect(out.thinkingText).toBe("");
    expect(out.thinkingStarted).toBeUndefined();
    expect(out.thinkingEnded).toBeUndefined();
  });

  it("suppresses thinking events for whitespace-only <think>\\n\\n</think>", () => {
    const parser = new TagPairParser();
    const out = parser.feed("<think>\n\n</think>b");
    expect(out.visibleText).toBe("b");
    expect(out.thinkingText).toBe("");
    expect(out.thinkingStarted).toBeUndefined();
    expect(out.thinkingEnded).toBeUndefined();
  });

  it("emits thinking events when first non-whitespace appears after leading whitespace", () => {
    const parser = new TagPairParser();
    const out = parser.feed("<think>\n  reasoning</think>b");
    expect(out.visibleText).toBe("b");
    expect(out.thinkingText).toBe("\n  reasoning");
    expect(out.thinkingStarted).toBe(true);
    expect(out.thinkingEnded).toBe(true);
  });

  it("flushes a partial open-tag buffer as visible text", () => {
    const parser = new TagPairParser();
    const a = parser.feed("<thi");
    const b = parser.flush();
    expect(a.visibleText).toBe("");
    expect(b.visibleText).toBe("<thi");
    expect(b.thinkingText).toBe("");
  });

  it("flushes mid-thinking content with thinkingEnded set", () => {
    const parser = new TagPairParser();
    const a = parser.feed("<think>partial");
    const b = parser.flush();
    expect(a.thinkingStarted).toBe(true);
    expect(a.thinkingText).toBe("partial");
    expect(b.thinkingEnded).toBe(true);
  });

  it("flushes mid-MAYBE_CLOSE buffer back into thinking text", () => {
    const parser = new TagPairParser();
    const a = parser.feed("<think>secret</thi");
    const b = parser.flush();
    expect(a.thinkingStarted).toBe(true);
    expect(a.thinkingText).toBe("secret");
    expect(b.thinkingText).toBe("</thi");
    expect(b.thinkingEnded).toBe(true);
  });

  it("returns empty chunks on flush after a clean stream", () => {
    const parser = new TagPairParser();
    parser.feed("<think>x</think>b");
    const out = parser.flush();
    expect(out.visibleText).toBe("");
    expect(out.thinkingText).toBe("");
    expect(out.thinkingStarted).toBeUndefined();
    expect(out.thinkingEnded).toBeUndefined();
  });

  it("recognises <THINK>, <Thinking>, and mixed-case close tags", () => {
    const parser = new TagPairParser();
    const out = parser.feed("<THINK>x</Think><Thinking>y</THINKING>c");
    expect(out.visibleText).toBe("c");
    expect(out.thinkingText).toBe("xy");
    expect(out.thinkingStarted).toBe(true);
    expect(out.thinkingEnded).toBe(true);
  });
});

describe("TagPairParser when the prompt opened the block", () => {
  const joined = (chunks: ReturnType<TagPairParser["feed"]>[]) => ({
    visible: chunks.map((chunk) => chunk.visibleText).join(""),
    thinking: chunks.map((chunk) => chunk.thinkingText).join(""),
  });

  it("holds the reply until </think>, then splits there", () => {
    const parser = new TagPairParser({ startsInsideBlock: true });
    const first = parser.feed("weigh it");
    expect(first.visibleText + first.thinkingText).toBe("");
    const out = joined([
      first,
      parser.feed(" up</thi"),
      parser.feed("nk>\n\nanswer"),
      parser.flush(),
    ]);
    expect(out.thinking).toBe("weigh it up");
    expect(out.visible).toBe("\n\nanswer");
  });

  it("keeps tags the answer quotes after the block closes", () => {
    const parser = new TagPairParser({ startsInsideBlock: true });
    const out = joined([parser.feed("plan</think>Use `<think>` and `</think>`."), parser.flush()]);
    expect(out.thinking).toBe("plan");
    expect(out.visible).toBe("Use `<think>` and `</think>`.");
  });

  it("gives back a reply that never closes the block as the answer", () => {
    const parser = new TagPairParser({ startsInsideBlock: true });
    const out = joined([
      parser.feed("the server already "),
      parser.feed("took the reasoning"),
      parser.flush(),
    ]);
    expect(out.visible).toBe("the server already took the reasoning");
    expect(out.thinking).toBe("");
  });

  it("accepts a reply that opens the block again itself", () => {
    const parser = new TagPairParser({ startsInsideBlock: true });
    const out = joined([
      parser.feed("\n<thi"),
      parser.feed("nk>plan</think>answer"),
      parser.flush(),
    ]);
    expect(out.thinking).toBe("plan");
    expect(out.visible).toBe("\nanswer");
  });
});

describe("TagPairParser stray close tags", () => {
  it("flags a </think> in the answer when no block was opened", () => {
    const parser = new TagPairParser();
    expect(parser.feed("leftover reasoning</thi").strayCloseTag).toBeUndefined();
    const out = parser.feed("nk>answer");
    expect(out.strayCloseTag).toBe(true);
    expect(parser.feed("more </think>").strayCloseTag).toBeUndefined();
  });

  it("does not flag a quoted </think> after a real block", () => {
    const parser = new TagPairParser();
    const out = parser.feed("<think>plan</think>strip up to `</think>`");
    expect(out.strayCloseTag).toBeUndefined();
  });
});

describe("generationPromptOpensBlock", () => {
  it("is true when the generation prompt opens <think> (QwQ, Qwen3 thinking, DeepSeek-R1)", () => {
    expect(
      generationPromptOpensBlock(
        "{%- for message in messages %}{{ message.content }}{%- endfor %}" +
          "{%- if add_generation_prompt %}{{- '<|im_start|>assistant\\n<think>\\n' }}{%- endif %}",
      ),
    ).toBe(true);
    expect(
      generationPromptOpensBlock(
        "{% if add_generation_prompt and not ns.is_tool %}{{'<｜Assistant｜><think>\\n'}}{% endif %}",
      ),
    ).toBe(true);
  });

  it("is false for a hybrid template that only closes an empty block to switch thinking off", () => {
    expect(
      generationPromptOpensBlock(
        "{%- if '</think>' in content %}{%- set content = content.split('</think>')[-1] %}{%- endif %}" +
          "{%- if add_generation_prompt %}{{- '<|im_start|>assistant\\n' }}" +
          "{%- if enable_thinking is defined and enable_thinking is false %}" +
          "{{- '<think>\\n\\n</think>\\n\\n' }}{%- endif %}{%- endif %}",
      ),
    ).toBe(false);
  });

  it("is false with no template or no generation prompt", () => {
    expect(generationPromptOpensBlock(undefined)).toBe(false);
    expect(
      generationPromptOpensBlock("{{ if .Thinking }}<think>{{ .Thinking }}</think>{{ end }}"),
    ).toBe(false);
  });
});

describe("TagPairParserFactory.canHandle", () => {
  it("returns true when chatTemplate contains <think>", () => {
    expect(
      TagPairParserFactory.canHandle({
        provider: "llamacpp",
        modelId: "qwen3-4b",
        chatTemplate: "...{% if reasoning %}<think>{% endif %}...",
      }),
    ).toBe(true);
  });

  it("returns true when chatTemplate contains <thinking>", () => {
    expect(
      TagPairParserFactory.canHandle({
        provider: "llamacpp",
        modelId: "custom",
        chatTemplate: "<thinking>...</thinking>",
      }),
    ).toBe(true);
  });

  it("returns false for a Harmony-style chat template even if <think> appears elsewhere", () => {
    expect(
      TagPairParserFactory.canHandle({
        provider: "llamacpp",
        modelId: "gpt-oss-20b",
        chatTemplate: "<|channel|>analysis<|message|>...<think>",
      }),
    ).toBe(false);
  });

  it("returns true when ollama capabilities include 'thinking'", () => {
    expect(
      TagPairParserFactory.canHandle({
        provider: "ollama",
        modelId: "qwen3:8b",
        capabilities: ["completion", "tools", "thinking"],
      }),
    ).toBe(true);
  });

  it("returns false for a model with no template and no thinking capability", () => {
    expect(
      TagPairParserFactory.canHandle({
        provider: "ollama",
        modelId: "llama3.1:8b",
        capabilities: ["completion", "tools"],
      }),
    ).toBe(false);
  });

  it("returns false for a cloud provider with no metadata", () => {
    expect(
      TagPairParserFactory.canHandle({ provider: "anthropic", modelId: "claude-sonnet-4-6" }),
    ).toBe(false);
  });
});
