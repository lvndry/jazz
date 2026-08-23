import { fileURLToPath } from "node:url";

import { defineConfig } from "astro/config";

import { remarkDocsLinks } from "./src/lib/remark-docs-links";

const docsRoot = fileURLToPath(new URL("../docs", import.meta.url));

export default defineConfig({
  trailingSlash: "never",
  build: {
    format: "file",
  },
  markdown: {
    shikiConfig: {
      theme: "css-variables",
    },
    remarkPlugins: [[remarkDocsLinks, { docsRoot, repoUrl: "https://github.com/lvndry/jazz" }]],
  },
});
