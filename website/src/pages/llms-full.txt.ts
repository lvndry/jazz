import { getCollection } from "astro:content";
import type { APIContext } from "astro";

import { SECTIONS, titleOf } from "../lib/docs";

/**
 * The complete Jazz documentation as a single plain-text file for LLM
 * consumption (the llms-full.txt convention). Pages appear in the canonical
 * section order; each page is delimited so models can cite exact sections.
 */
export async function GET({ site }: APIContext): Promise<Response> {
  const entries = await getCollection("docs");
  const base = new URL(site ?? "https://jazz-cli.vercel.app");
  const order = new Map(SECTIONS.map((section, index) => [section.dir, index]));
  const sorted = [...entries].sort((a, b) => {
    const sectionA = order.get(a.id.split("/")[0] ?? "") ?? 99;
    const sectionB = order.get(b.id.split("/")[0] ?? "") ?? 99;
    return sectionA - sectionB || a.id.localeCompare(b.id);
  });

  const header = [
    "# Jazz — full documentation",
    "",
    "> Jazz is an open-source AI agent harness that runs a general-purpose AI agent on your own machine —",
    "> terminal, scripts, cron, CI, Telegram, Discord. Self-hosted and fully local-capable:",
    "> 18 LLM providers, including offline models via Ollama and llama.cpp.",
    "> MIT licensed. Install with a single curl command; ships as a self-contained binary for macOS and Linux.",
    "",
    `Install: curl -fsSL https://github.com/lvndry/jazz/releases/latest/download/install.sh | bash`,
    "Source: https://github.com/lvndry/jazz",
    `Table of contents with per-page links: ${new URL("/llms.txt", base).href}`,
    "",
  ];

  const pages = sorted.map((entry) => {
    const url = new URL(`/docs/${entry.id}.md`, base).href;
    return [
      "---",
      "",
      `## ${titleOf(entry)}`,
      `Source: ${url}`,
      "",
      entry.body?.trim() ?? "",
      "",
    ].join("\n");
  });

  return new Response(header.join("\n") + pages.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
