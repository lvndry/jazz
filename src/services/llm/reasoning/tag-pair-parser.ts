import type { ParseChunk, ReasoningParser } from "./types";

export class TagPairParser implements ReasoningParser {
  feed(input: string): ParseChunk {
    return { visibleText: input, thinkingText: "" };
  }

  flush(): ParseChunk {
    return { visibleText: "", thinkingText: "" };
  }
}
