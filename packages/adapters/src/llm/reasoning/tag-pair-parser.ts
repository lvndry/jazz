/**
 * `ReasoningParser` for models that emit reasoning in-band as `<think>`/`<thinking>` tags.
 * A character-by-character state machine so a tag split across two stream chunks is still
 * recognized correctly.
 *
 * Reasoning is a prefix of the reply. A block opens only before the answer starts: once visible
 * text has appeared, a `<think>` is the answer quoting the tag (a regex, docs, a code review) and
 * stays.
 *
 * Some chat templates open the block in the prompt (`…assistant\n<think>\n`), so the reply starts
 * inside it with no opening tag. For those the parser holds the text until `</think>` and splits
 * there; a reply that never closes the block was all answer, so a wrong guess hides nothing.
 */

import type {
  ParseChunk,
  ReasoningParser,
  ReasoningParserFactory,
  ParserSelectionContext,
} from "./types";

type State = "OUTSIDE" | "MAYBE_OPEN" | "INSIDE" | "MAYBE_CLOSE";

const OPEN_TAGS = ["<think>", "<thinking>"];
const CLOSE_TAGS = ["</think>", "</thinking>"];
const MAX_OPEN_LEN = Math.max(...OPEN_TAGS.map((t) => t.length));
const MAX_CLOSE_LEN = Math.max(...CLOSE_TAGS.map((t) => t.length));

type MatchResult = "match" | "partial" | "fail";

const CLOSE_TAG = /<\/think(?:ing)?>/i;
const STRING_LITERAL = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;

/**
 * True when the chat template's generation prompt ends inside a reasoning block: one of its
 * string literals opens `<think>` without closing it. A literal that opens and closes
 * (`<think>\n\n</think>`, how hybrid templates switch thinking off) does not count.
 */
export function generationPromptOpensBlock(chatTemplate: string | undefined): boolean {
  if (!chatTemplate) return false;
  const promptStart = chatTemplate.lastIndexOf("add_generation_prompt");
  if (promptStart === -1) return false;
  for (const [literal] of chatTemplate.slice(promptStart).matchAll(STRING_LITERAL)) {
    const lower = literal.toLowerCase();
    const open = Math.max(lower.lastIndexOf("<think>"), lower.lastIndexOf("<thinking>"));
    if (open !== -1 && !CLOSE_TAG.test(lower.slice(open))) return true;
  }
  return false;
}

export interface TagPairParserOptions {
  /** The prompt already opened the block, so the reply starts inside it. */
  readonly startsInsideBlock?: boolean;
}

function matchAny(buf: string, candidates: readonly string[]): MatchResult {
  const lower = buf.toLowerCase();
  let anyPrefix = false;
  for (const tag of candidates) {
    if (lower === tag) return "match";
    if (tag.startsWith(lower)) anyPrefix = true;
  }
  return anyPrefix ? "partial" : "fail";
}

export class TagPairParser implements ReasoningParser {
  private state: State = "OUTSIDE";
  private buffer = "";
  private sawThinkingContent = false;
  private pendingThinking = "";
  private answerStarted = false;
  private blockOpened = false;
  private strayCloseReported = false;
  private visibleTail = "";
  /** Text held while inside a block the prompt opened; `null` once that is settled. */
  private heldBlock: string | null;

  constructor(options: TagPairParserOptions = {}) {
    this.heldBlock = options.startsInsideBlock ? "" : null;
  }

  feed(input: string): ParseChunk {
    if (this.heldBlock !== null) return this.feedHeldBlock(input);
    return this.feedTags(input);
  }

  flush(): ParseChunk {
    if (this.heldBlock !== null) {
      const answer = this.heldBlock;
      this.heldBlock = null;
      return this.makeChunk(answer, "", false, false);
    }
    return this.flushTags();
  }

  private feedHeldBlock(input: string): ParseChunk {
    const held = (this.heldBlock ?? "") + input;
    const leading = held.trimStart().toLowerCase();
    if (OPEN_TAGS.some((tag) => leading.startsWith(tag))) {
      this.heldBlock = null;
      return this.feedTags(held);
    }
    if (OPEN_TAGS.some((tag) => tag.startsWith(leading))) {
      this.heldBlock = held;
      return this.makeChunk("", "", false, false);
    }
    const close = CLOSE_TAG.exec(held);
    if (!close) {
      this.heldBlock = held;
      return this.makeChunk("", "", false, false);
    }
    this.heldBlock = null;
    this.blockOpened = true;
    this.answerStarted = true;
    const thinking = held.slice(0, close.index);
    const hasThinking = /\S/.test(thinking);
    return this.makeChunk(
      held.slice(close.index + close[0].length),
      hasThinking ? thinking : "",
      hasThinking,
      hasThinking,
    );
  }

  private feedTags(input: string): ParseChunk {
    let visibleText = "";
    let thinkingText = "";
    let thinkingStarted = false;
    let thinkingEnded = false;

    for (const ch of input) {
      const result = this.consume(ch);
      visibleText += result.visibleText;
      thinkingText += result.thinkingText;
      if (result.thinkingStarted) thinkingStarted = true;
      if (result.thinkingEnded) thinkingEnded = true;
    }

    const chunk = this.makeChunk(visibleText, thinkingText, thinkingStarted, thinkingEnded);
    return this.reportStrayClose(chunk);
  }

  /**
   * Flags the first `</think>` in the answer when no block was ever opened: usually reasoning
   * the server left in the text, which the parser cannot place without guessing.
   */
  private reportStrayClose(chunk: ParseChunk): ParseChunk {
    if (this.blockOpened || this.strayCloseReported || chunk.visibleText.length === 0) {
      return chunk;
    }
    const window = this.visibleTail + chunk.visibleText;
    this.visibleTail = window.slice(-MAX_CLOSE_LEN);
    if (!CLOSE_TAG.test(window)) return chunk;
    this.strayCloseReported = true;
    return { ...chunk, strayCloseTag: true };
  }

  private flushTags(): ParseChunk {
    let visibleText = "";
    let thinkingText = "";
    let thinkingStarted = false;
    let thinkingEnded = false;

    if (this.state === "MAYBE_OPEN") {
      visibleText += this.buffer;
      this.buffer = "";
      this.state = "OUTSIDE";
    } else if (this.state === "MAYBE_CLOSE") {
      const text = this.pendingThinking + this.buffer;
      if (this.sawThinkingContent) {
        thinkingText += text;
      } else if (/\S/.test(text)) {
        thinkingStarted = true;
        thinkingText += text;
        this.sawThinkingContent = true;
      }
      this.buffer = "";
      this.pendingThinking = "";
      this.state = "INSIDE";
    }

    if (this.state === "INSIDE" && this.sawThinkingContent) {
      thinkingEnded = true;
    }

    return this.makeChunk(visibleText, thinkingText, thinkingStarted, thinkingEnded);
  }

  private consume(ch: string): {
    visibleText: string;
    thinkingText: string;
    thinkingStarted: boolean;
    thinkingEnded: boolean;
  } {
    let visibleText = "";
    let thinkingText = "";
    let thinkingStarted = false;
    let thinkingEnded = false;

    switch (this.state) {
      case "OUTSIDE": {
        if (ch === "<" && !this.answerStarted) {
          this.buffer = "<";
          this.state = "MAYBE_OPEN";
        } else {
          visibleText += ch;
          if (/\S/.test(ch)) this.answerStarted = true;
        }
        break;
      }
      case "MAYBE_OPEN": {
        this.buffer += ch;
        const m = matchAny(this.buffer, OPEN_TAGS);
        if (m === "match") {
          this.state = "INSIDE";
          this.blockOpened = true;
          this.sawThinkingContent = false;
          this.pendingThinking = "";
          this.buffer = "";
        } else if (m === "fail" || this.buffer.length > MAX_OPEN_LEN) {
          visibleText += this.buffer;
          this.buffer = "";
          this.state = "OUTSIDE";
          this.answerStarted = true;
        }
        break;
      }
      case "INSIDE": {
        if (ch === "<") {
          this.buffer = "<";
          this.state = "MAYBE_CLOSE";
        } else if (this.sawThinkingContent) {
          thinkingText += ch;
        } else if (/\s/.test(ch)) {
          this.pendingThinking += ch;
        } else {
          this.sawThinkingContent = true;
          thinkingStarted = true;
          thinkingText += this.pendingThinking + ch;
          this.pendingThinking = "";
        }
        break;
      }
      case "MAYBE_CLOSE": {
        this.buffer += ch;
        const m = matchAny(this.buffer, CLOSE_TAGS);
        if (m === "match") {
          if (this.sawThinkingContent) {
            thinkingEnded = true;
          }
          this.buffer = "";
          this.pendingThinking = "";
          this.sawThinkingContent = false;
          this.state = "OUTSIDE";
        } else if (m === "fail" || this.buffer.length > MAX_CLOSE_LEN) {
          if (this.sawThinkingContent) {
            thinkingText += this.buffer;
          } else {
            const idx = this.buffer.search(/\S/);
            if (idx !== -1) {
              this.sawThinkingContent = true;
              thinkingStarted = true;
              thinkingText += this.pendingThinking + this.buffer;
              this.pendingThinking = "";
            } else {
              this.pendingThinking += this.buffer;
            }
          }
          this.buffer = "";
          this.state = "INSIDE";
        }
        break;
      }
    }

    return { visibleText, thinkingText, thinkingStarted, thinkingEnded };
  }

  private makeChunk(
    visibleText: string,
    thinkingText: string,
    thinkingStarted: boolean,
    thinkingEnded: boolean,
  ): ParseChunk {
    const chunk: {
      visibleText: string;
      thinkingText: string;
      thinkingStarted?: boolean;
      thinkingEnded?: boolean;
    } = {
      visibleText,
      thinkingText,
    };
    if (thinkingStarted) chunk.thinkingStarted = true;
    if (thinkingEnded) chunk.thinkingEnded = true;
    return chunk;
  }
}

export const TagPairParserFactory: ReasoningParserFactory = {
  id: "tag-pair",
  canHandle(ctx: ParserSelectionContext): boolean {
    if (ctx.chatTemplate) {
      if (/<\|channel\|>analysis/.test(ctx.chatTemplate)) return false;
      if (/<think(ing)?>/i.test(ctx.chatTemplate)) return true;
    }
    if (ctx.capabilities?.includes("thinking")) return true;
    return false;
  },
  create(ctx: ParserSelectionContext) {
    return new TagPairParser({ startsInsideBlock: generationPromptOpensBlock(ctx.chatTemplate) });
  },
};
