import { fileURLToPath } from "node:url";

import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

import { SITE_BASE, SITE_ORIGIN } from "./site";
import { remarkDocsLinks } from "./src/lib/remark-docs-links";

const docsRoot = fileURLToPath(new URL("../../docs", import.meta.url));

export default defineConfig({
  site: SITE_ORIGIN,
  base: SITE_BASE,
  trailingSlash: "never",
  // Addresses of pages the docs reorganization moved into the guides. Astro does not add
  // the base to a redirect's destination, so it is written in.
  redirects: {
    "/docs/examples": `${SITE_BASE}/docs/guides`,
    "/docs/guide/use-cases": `${SITE_BASE}/docs/guides`,
  },
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
    remarkPlugins: [
      [remarkDocsLinks, { docsRoot, repoUrl: "https://github.com/lvndry/jazz", base: SITE_BASE }],
    ],
  },
});
