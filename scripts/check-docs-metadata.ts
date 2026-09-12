/**
 * Validates the search metadata for every published documentation page.
 *
 * The website can derive a title from the first H1, but every page must provide an explicit,
 * specific description. This keeps browser snippets, Open Graph previews, the docs search index,
 * and machine-readable documentation useful after files are added or moved.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const EXCLUDED_DIRECTORIES = ["docs/superpowers", "docs/plans"];
const MIN_DESCRIPTION_LENGTH = 50;
const MAX_DESCRIPTION_LENGTH = 180;

function markdownFiles(directory: string, collected: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const entryPath = path.join(directory, entry);
    if (EXCLUDED_DIRECTORIES.some((excluded) => entryPath.startsWith(excluded))) continue;
    if (statSync(entryPath).isDirectory()) markdownFiles(entryPath, collected);
    else if (entry.endsWith(".md")) collected.push(entryPath);
  }
  return collected;
}

function main(): void {
  const errors: string[] = [];
  const descriptions = new Map<string, string>();

  for (const file of markdownFiles("docs").sort()) {
    const parsed = matter(readFileSync(file, "utf-8"));
    const h1 = parsed.content.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const title = typeof parsed.data["title"] === "string" ? parsed.data["title"].trim() : h1;
    if (!title) errors.push(`${file}: missing title and H1`);

    const description: unknown = parsed.data["description"];
    if (typeof description !== "string") {
      errors.push(`${file}: missing frontmatter description`);
      continue;
    }
    const normalized = description.trim().replace(/\s+/g, " ");
    if (normalized.length < MIN_DESCRIPTION_LENGTH || normalized.length > MAX_DESCRIPTION_LENGTH) {
      errors.push(
        `${file}: description is ${normalized.length} characters; expected ${MIN_DESCRIPTION_LENGTH}-${MAX_DESCRIPTION_LENGTH}`,
      );
    }
    const previous = descriptions.get(normalized);
    if (previous) errors.push(`${file}: description duplicates ${previous}`);
    else descriptions.set(normalized, file);
  }

  if (errors.length > 0) {
    console.error(`✗ ${errors.length} documentation metadata issue(s):\n`);
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }

  console.log(`✓ metadata is specific and complete in ${descriptions.size} documentation pages`);
}

main();
