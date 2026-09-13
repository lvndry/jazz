import { glob } from "astro/loaders";
import { defineCollection, z } from "astro:content";

export const collections = {
  docs: defineCollection({
    loader: glob({
      pattern: ["**/*.md", "!superpowers/**", "!plans/**", "!README.md"],
      base: "../../docs",
    }),
    schema: z.object({
      title: z.string().optional(),
      description: z.string().optional(),
    }),
  }),
  personas: defineCollection({
    loader: glob({
      pattern: "**/{PERSONA,persona}.md",
      base: "./src/content/marketplace/personas",
    }),
    schema: z.object({
      name: z.string(),
      description: z.string(),
      tone: z.string().optional(),
      style: z.string().optional(),
      author: z.string().optional(),
      tags: z.array(z.string()).default([]),
    }),
  }),
  workflows: defineCollection({
    loader: glob({
      pattern: "**/{WORKFLOW,workflow}.md",
      base: "./src/content/marketplace/workflows",
    }),
    schema: z.object({
      name: z.string(),
      description: z.string(),
      schedule: z.string().optional(),
      autoApprove: z
        .union([z.boolean(), z.enum(["read-only", "low-risk", "high-risk"])])
        .optional(),
      author: z.string().optional(),
      tags: z.array(z.string()).default([]),
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
