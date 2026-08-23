/**
 * Scans dist/ for internal links and fails if any points at a file the build
 * did not produce — so a docs refactor can't silently 404 the site.
 */
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const distRoot = join(fileURLToPath(new URL("..", import.meta.url)), "dist");

async function collectFiles(dir: string): Promise<string[]> {
  const dirents = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    dirents.map((dirent) => {
      const full = join(dir, dirent.name);
      return dirent.isDirectory() ? collectFiles(full) : Promise.resolve([full]);
    }),
  );
  return files.flat();
}

const files = await collectFiles(distRoot);
const produced = new Set(files.map((file) => "/" + relative(distRoot, file).split("/").join("/")));

const exists = (target: string): boolean => {
  const clean = target.replace(/\/+$/, "");
  return (
    produced.has(clean) ||
    produced.has(`${clean}.html`) ||
    produced.has(`${clean}/index.html`) ||
    produced.has(clean === "" ? "/index.html" : `${clean}.html`)
  );
};

const htmlFiles = files.filter((file) => file.endsWith(".html"));
const broken: string[] = [];

for (const file of htmlFiles) {
  const html = await Bun.file(file).text();
  const hrefs = [...html.matchAll(/(?:href|src)="(\/[^"#?]*)/g)].map((match) => match[1] ?? "");
  for (const href of new Set(hrefs)) {
    if (href.startsWith("/pagefind/")) continue;
    if (!exists(decodeURI(href))) {
      broken.push(`${relative(distRoot, file)} → ${href}`);
    }
  }
}

if (broken.length > 0) {
  console.error(`${broken.length} broken internal link(s):`);
  for (const line of broken) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`checked ${htmlFiles.length} pages — no broken internal links`);
