import { fileURLToPath } from "node:url";

import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

import { remarkDocsLinks } from "./src/lib/remark-docs-links";

const docsRoot = fileURLToPath(new URL("../docs", import.meta.url));

export default defineConfig({
  // TODO(launch): confirm the production domain — everything else is
  // domain-agnostic, this one constant is the only thing to change.
  site: "https://jazz.sh",
  trailingSlash: "never",
  build: {
    format: "file",
  },
  integrations: [sitemap()],
  markdown: {
    shikiConfig: {
      theme: "css-variables",
    },
    remarkPlugins: [[remarkDocsLinks, { docsRoot, repoUrl: "https://github.com/lvndry/jazz" }]],
  },
});
