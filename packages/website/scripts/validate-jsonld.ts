/**
 * Build-time structured-data validator: parses every JSON-LD block in the
 * built site and fails the build on malformed JSON, missing @context, or
 * missing required fields per schema type. Run after `astro build` so schema
 * drift can never ship silently.
 *
 * Usage: bun run scripts/validate-jsonld.ts [distDir]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REQUIRED_FIELDS: Record<string, string[]> = {
  Organization: ["name", "url", "sameAs"],
  SoftwareApplication: ["name", "applicationCategory", "offers"],
  FAQPage: ["mainEntity"],
  Question: ["name", "acceptedAnswer"],
  BreadcrumbList: ["itemListElement"],
  TechArticle: ["headline", "description"],
  BlogPosting: ["headline", "datePublished", "author"],
};

function* htmlFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(path);
    else if (entry.name.endsWith(".html")) yield path;
  }
}

const distDir = process.argv[2] ?? "dist";
let blocks = 0;
const errors: string[] = [];

for (const file of htmlFiles(distDir)) {
  const html = readFileSync(file, "utf8");
  const matches = [
    ...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g),
  ];
  for (const [index, match] of matches.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch (error) {
      errors.push(`${file} [block ${index}]: invalid JSON — ${(error as Error).message}`);
      continue;
    }
    const nodes = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of nodes) {
      if (typeof node !== "object" || node === null || !("@type" in node)) {
        errors.push(`${file} [block ${index}]: node without @type`);
        continue;
      }
      const typed = node as { "@type": string; [key: string]: unknown };
      const types = Array.isArray(typed["@type"]) ? typed["@type"] : [typed["@type"]];
      for (const type of types) {
        if (!("@context" in typed)) {
          errors.push(`${file} [block ${index}] ${type}: missing @context`);
        }
        for (const field of REQUIRED_FIELDS[type] ?? []) {
          if (typed[field] === undefined) {
            errors.push(`${file} [block ${index}] ${type}: missing "${field}"`);
          }
        }
      }
    }
    blocks += nodes.length;
  }
}

if (errors.length > 0) {
  console.error(`JSON-LD validation failed (${errors.length} errors):`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}
console.log(`JSON-LD OK — ${blocks} validated schema nodes across ${distDir}/`);
