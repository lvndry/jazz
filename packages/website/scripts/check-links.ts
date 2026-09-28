/**
 * Scans dist/ for internal links and fails if any points at a file the build
 * did not produce, or at a `#fragment` the target page has no element for, so a
 * docs refactor can't silently 404 the site or land a reader at the top of the
 * wrong page. Fragments are checked against the `id` attributes the build
 * actually emitted, which are the website's own heading slugs.
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

/** The produced file a route serves, or undefined when the build made none. */
const resolveRoute = (target: string): string | undefined => {
  const clean = target.replace(/\/+$/, "");
  const candidates = [
    clean,
    `${clean}.html`,
    `${clean}/index.html`,
    clean === "" ? "/index.html" : `${clean}.html`,
  ];
  return candidates.find((candidate) => produced.has(candidate));
};

const ID_PATTERN = /\sid="([^"]+)"/g;
const idsByPage = new Map<string, ReadonlySet<string>>();

async function idsOf(producedPath: string): Promise<ReadonlySet<string>> {
  const cached = idsByPage.get(producedPath);
  if (cached !== undefined) {
    return cached;
  }
  const html = await Bun.file(join(distRoot, producedPath)).text();
  const ids = new Set([...html.matchAll(ID_PATTERN)].map((match) => match[1] ?? ""));
  idsByPage.set(producedPath, ids);
  return ids;
}

const htmlFiles = files.filter((file) => file.endsWith(".html"));
const broken: string[] = [];

for (const file of htmlFiles) {
  const html = await Bun.file(file).text();
  const ownPath = "/" + relative(distRoot, file).split("/").join("/");
  const links = [...html.matchAll(/(?:href|src)="((?:\/|#)[^"]*)"/g)].map(
    (match) => match[1] ?? "",
  );
  for (const link of new Set(links)) {
    const [routeWithQuery = "", fragment] = link.split("#");
    const route = routeWithQuery.split("?")[0] ?? "";
    if (route.startsWith("/pagefind/")) continue;
    const target = route === "" ? ownPath : resolveRoute(decodeURI(route));
    if (target === undefined) {
      broken.push(`${relative(distRoot, file)} → ${link}`);
      continue;
    }
    if (fragment === undefined || fragment.length === 0 || !target.endsWith(".html")) continue;
    if (!(await idsOf(target)).has(decodeURIComponent(fragment))) {
      broken.push(`${relative(distRoot, file)} → ${link} (no element with id "${fragment}")`);
    }
  }
}

if (broken.length > 0) {
  console.error(`${broken.length} broken internal link(s):`);
  for (const line of broken) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`checked ${htmlFiles.length} pages: no broken internal links or anchors`);
