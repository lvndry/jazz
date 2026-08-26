// The markdown lexers that re-run for every dirty block on every frame.
import { markdownReply, PROSE_PARAGRAPH } from "./corpus";
import { bench, report } from "./harness";
import { parseProse, inlineSegments } from "../packages/cli/src/ui/fullscreen/Transcript";
import { getGlyphs } from "../packages/cli/src/ui/glyphs";

const glyphs = getGlyphs();
const shortReply = markdownReply(500);
const longReply = markdownReply(50_000);
const inlineLine =
  "A line with **bold**, `code`, _italic_, and a [link](https://example.com) to lex.";

const results = [
  bench("parseProse 500B reply", () => {
    parseProse(shortReply, glyphs);
  }),
  bench(
    "parseProse 50KB reply",
    () => {
      parseProse(longReply, glyphs);
    },
    { iterations: 60 },
  ),
  bench("parseProse plain paragraph", () => {
    parseProse(PROSE_PARAGRAPH, glyphs);
  }),
  bench("inlineSegments mixed marks", () => {
    inlineSegments(inlineLine, "#ffffff", glyphs);
  }),
];

report("markdown-prose", results);
