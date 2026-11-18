import rss from "@astrojs/rss";
import { absoluteUrl } from "../lib/url";
import { getCollection } from "astro:content";

export async function GET(): Promise<Response> {
  const posts = await getCollection("blog", ({ data }) => data.draft !== true);
  return rss({
    title: "Jazz blog",
    description:
      "Essays from building Jazz: approvals that travel, context under pressure, and measuring agents on everyday work.",
    site: absoluteUrl("/"),
    trailingSlash: false,
    items: posts
      .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf())
      .map((post) => ({
        title: post.data.title,
        description: post.data.description,
        pubDate: post.data.date,
        link: absoluteUrl(`/blog/${post.id}`),
      })),
    customData: "<language>en</language>",
  });
}
