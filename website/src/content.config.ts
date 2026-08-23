import { glob } from "astro/loaders";
import { defineCollection } from "astro:content";

export const collections = {
  docs: defineCollection({
    loader: glob({ pattern: ["**/*.md", "!superpowers/**"], base: "../docs" }),
  }),
};
