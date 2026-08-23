import { getCollection } from "astro:content";

import { SECTIONS, titleOf } from "../lib/docs";

export async function GET(): Promise<Response> {
  const entries = await getCollection("docs");
  const order = new Map(SECTIONS.map((section, index) => [section.dir, index]));
  const sorted = [...entries].sort((a, b) => {
    const sectionA = order.get(a.id.split("/")[0] ?? "") ?? 99;
    const sectionB = order.get(b.id.split("/")[0] ?? "") ?? 99;
    return sectionA - sectionB || a.id.localeCompare(b.id);
  });

  const lines = [
    "# Jazz",
    "",
    "> Jazz runs a general-purpose AI agent on your own machine —",
    "> terminal, scripts, cron, CI, Telegram, Discord. 18 LLM providers,",
    "> including fully local models. MIT licensed.",
    "",
    "Install: curl -fsSL https://github.com/lvndry/jazz/releases/latest/download/install.sh | bash",
    "Source: https://github.com/lvndry/jazz",
    "",
    "## Docs",
    "",
    ...sorted.map((entry) => `- [${titleOf(entry)}](/docs/${entry.id}.md)`),
  ];

  return new Response(lines.join("\n") + "\n", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
