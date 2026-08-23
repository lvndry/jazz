import { defineConfig } from "astro/config";

export default defineConfig({
  trailingSlash: "never",
  build: {
    format: "file",
  },
});
