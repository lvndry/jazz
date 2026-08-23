// The one-shot / Ink-path markdown pipeline: ~15 sequential full-string regex
// passes over every reply. Chalk is forced on so the styling passes do real
// work, matching a user's terminal rather than a piped bench run.
import chalk from "chalk";
import { markdownReply } from "./corpus";
import { bench, report } from "./harness";
import { formatMarkdown } from "../src/cli/presentation/markdown-formatter";

chalk.level = 3;

const shortReply = markdownReply(500);
const mediumReply = markdownReply(5_000);
const longReply = markdownReply(50_000);

const results = [
  bench("formatMarkdown 500B", () => {
    formatMarkdown(shortReply);
  }),
  bench("formatMarkdown 5KB", () => {
    formatMarkdown(mediumReply);
  }),
  bench(
    "formatMarkdown 50KB",
    () => {
      formatMarkdown(longReply);
    },
    { iterations: 40 },
  ),
];

report("format-markdown", results);
