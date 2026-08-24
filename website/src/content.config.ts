import { glob } from "astro/loaders";
import { defineCollection, z } from "astro:content";

export const collections = {
  docs: defineCollection({
    loader: glob({
      pattern: ["**/*.md", "!superpowers/**", "!plans/**", "!README.md"],
      base: "../docs",
    }),
  }),
  blog: defineCollection({
    loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
    schema: z.object({
      title: z.string(),
      description: z.string(),
      date: z.coerce.date(),
      draft: z.boolean().optional(),
    }),
  }),
};
