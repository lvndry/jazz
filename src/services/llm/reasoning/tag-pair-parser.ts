import type { ParseChunk, ReasoningParser, ReasoningParserFactory, ParserSelectionContext } from "./types";

type State = "OUTSIDE" | "MAYBE_OPEN" | "INSIDE" | "MAYBE_CLOSE";

const OPEN_TAGS = ["<think>", "<thinking>"];
const CLOSE_TAGS = ["</think>", "</thinking>"];
const MAX_OPEN_LEN = Math.max(...OPEN_TAGS.map((t) => t.length));
const MAX_CLOSE_LEN = Math.max(...CLOSE_TAGS.map((t) => t.length));

type MatchResult = "match" | "partial" | "fail";

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

  feed(input: string): ParseChunk {
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

    return this.makeChunk(visibleText, thinkingText, thinkingStarted, thinkingEnded);
  }

  flush(): ParseChunk {
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
        if (ch === "<") {
          this.buffer = "<";
          this.state = "MAYBE_OPEN";
        } else {
          visibleText += ch;
        }
        break;
      }
      case "MAYBE_OPEN": {
        this.buffer += ch;
        const m = matchAny(this.buffer, OPEN_TAGS);
        if (m === "match") {
          this.state = "INSIDE";
          this.sawThinkingContent = false;
          this.pendingThinking = "";
          this.buffer = "";
        } else if (m === "fail" || this.buffer.length > MAX_OPEN_LEN) {
          visibleText += this.buffer;
          this.buffer = "";
          this.state = "OUTSIDE";
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
    const chunk: { visibleText: string; thinkingText: string; thinkingStarted?: boolean; thinkingEnded?: boolean } = {
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
  create() {
    return new TagPairParser();
  },
};
