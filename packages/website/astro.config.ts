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
  // Compression drops a line break that is the only space between text and an
  // inline element, gluing words ("intopackages/", "don'tturn"). Prettier wraps
  // long paragraphs exactly there, so keeping whitespace is the only fix that holds.
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
