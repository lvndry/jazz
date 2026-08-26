import { getCollection } from "astro:content";
import type { APIContext } from "astro";

import { SECTIONS, titleOf } from "../lib/docs";

export async function GET({ site }: APIContext): Promise<Response> {
  const entries = await getCollection("docs");
  const base = new URL(site ?? "https://jazz-cli.vercel.app");
  const order = new Map(SECTIONS.map((section, index) => [section.dir, index]));
  const sorted = [...entries].sort((a, b) => {
    const sectionA = order.get(a.id.split("/")[0] ?? "") ?? 99;
    const sectionB = order.get(b.id.split("/")[0] ?? "") ?? 99;
    return sectionA - sectionB || a.id.localeCompare(b.id);
  });

  const lines = [
    "# Jazz",
    "",
    "> Jazz is an open-source AI agent harness that runs a general-purpose AI agent on your own machine —",
    "> terminal, scripts, cron, CI, Telegram, Discord. Self-hosted and fully local-capable:",
    "> 18 LLM providers, including offline models via Ollama and llama.cpp.",
    "> MIT licensed. Install with a single curl command; ships as a self-contained binary for macOS and Linux.",
    "",
    `Install: curl -fsSL https://github.com/lvndry/jazz/releases/latest/download/install.sh | bash`,
    "npm package: https://www.npmjs.com/package/jazz-ai",
    "Source: https://github.com/lvndry/jazz",
    `Full docs in one file: ${new URL("/llms-full.txt", base).href}`,
    "",
    "## Docs",
    "",
    ...sorted.map(
      (entry) =>
        `- [${titleOf(entry)}](${new URL(`/docs/${entry.id}.md`, base).href}): ${
          (entry.data.description as string | undefined) ??
          entry.body?.match(/^#\s+(.+)$/m)?.[1] ??
          ""
        }`,
    ),
  ];

  return new Response(lines.join("\n") + "\n", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
