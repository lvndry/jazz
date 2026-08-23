import { glob } from "astro/loaders";
import { defineCollection, z } from "astro:content";

export const collections = {
  docs: defineCollection({
    loader: glob({ pattern: ["**/*.md", "!superpowers/**", "!README.md"], base: "../docs" }),
  }),
  blog: defineCollection({
    loader: glob({ pattern: "**/*.md", base: "../blog" }),
    schema: z.object({
      title: z.string(),
      description: z.string(),
      date: z.coerce.date(),
      draft: z.boolean().optional(),
    }),
  }),
};
