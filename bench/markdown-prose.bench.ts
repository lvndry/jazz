// The markdown lexers that re-run for every dirty block on every frame.
import { markdownReply, PROSE_PARAGRAPH } from "./corpus";
import { bench, report } from "./harness";
import { getGlyphs } from "../packages/cli/src/ui/glyphs";
import { parseInlineMarkdown } from "../packages/cli/src/ui/markdown/inline";
import { parseMarkdown } from "../packages/cli/src/ui/markdown/parse";

const glyphs = getGlyphs();
const shortReply = markdownReply(500);
const longReply = markdownReply(50_000);
const inlineLine =
  "A line with **bold**, `code`, _italic_, and a [link](https://example.com) to lex.";

const results = [
  bench("parseMarkdown 500B reply", () => {
    parseMarkdown(shortReply, { glyphs });
  }),
  bench(
    "parseMarkdown 50KB reply",
    () => {
      parseMarkdown(longReply, { glyphs });
    },
    { iterations: 60 },
  ),
  bench("parseMarkdown plain paragraph", () => {
    parseMarkdown(PROSE_PARAGRAPH, { glyphs });
  }),
  bench("parseInlineMarkdown mixed marks", () => {
    parseInlineMarkdown(inlineLine, "text", { glyphs });
  }),
];

report("markdown-prose", results);
