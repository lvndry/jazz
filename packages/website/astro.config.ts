import { fileURLToPath } from "node:url";

import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

import { remarkDocsLinks } from "./src/lib/remark-docs-links";

const docsRoot = fileURLToPath(new URL("../../docs", import.meta.url));

export default defineConfig({
  // TODO(launch): confirm the production domain — everything else is
  // domain-agnostic, this one constant is the only thing to change.
  site: "https://jazz-cli.vercel.app",
  trailingSlash: "never",
  // The compressor drops the whitespace between a word and an inline tag
  // that starts the next source line ("a\n<code>WORKFLOW.md</code>" rendered
  // as "aWORKFLOW.md"). Costs ~12% larger HTML, ~1 KB gzipped per page.
  compressHTML: false,
  build: {
    format: "file",
  },
  integrations: [
    sitemap({
      serialize: (item) => ({
        ...item,
        url: item.url.replace(/index\.html$/, "").replace(/\.html$/, ""),
      }),
    }),
  ],
  markdown: {
    shikiConfig: {
      theme: "css-variables",
    },
    remarkPlugins: [[remarkDocsLinks, { docsRoot, repoUrl: "https://github.com/lvndry/jazz" }]],
  },
});
