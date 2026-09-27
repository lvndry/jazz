/**
 * Verifies every relative Markdown link in published Markdown resolves, including its
 * `#fragment`.
 *
 * Resolution is deliberately case-sensitive even on macOS: links are checked against the
 * paths git actually tracks, because that is what GitHub and Linux checkouts serve. A link
 * to `docs/SECURITY.md` when git tracks `docs/security.md` works locally and 404s in
 * production, so the filesystem is the wrong oracle here.
 *
 * A fragment must name a heading in the target Markdown file (or the same file, for a bare
 * `#fragment`), slugged with github-slugger: the rule both GitHub and the website's Markdown
 * pipeline use, including the `-1`, `-2` suffixes for repeated headings. An explicit
 * `id="..."` or `name="..."` in the file's HTML also counts. Fragments on links to
 * non-Markdown files are not checked, since those have no headings.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import GithubSlugger from "github-slugger";
import matter from "gray-matter";
import { marked, type Token, type Tokens } from "marked";

/** Local-only plans; gitignored, so their links are not part of the published docs. */
const EXCLUDED_DIRS = ["docs/superpowers"];

const LINK_PATTERN = /\]\(([^)]+)\)/g;

function trackedPaths(): Set<string> {
  const result = spawnSync("git", ["ls-files"], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr}`);
  }
  const paths = new Set(result.stdout.split("\n").filter((line) => line.length > 0));

  // ls-files reports the index, so a deletion that is not staged is still listed: exactly the
  // half-finished docs move this check exists to catch. Git rather than `existsSync` because it
  // records the true case of every path.
  const deleted = spawnSync("git", ["diff", "--name-only", "--diff-filter=D"], {
    encoding: "utf-8",
  });
  if (deleted.status !== 0) {
    throw new Error(`git diff failed: ${deleted.stderr}`);
  }
  for (const file of deleted.stdout.split("\n")) {
    if (file.length > 0) paths.delete(file);
  }

  return paths;
}

function markdownFiles(directory: string, collected: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const entryPath = path.join(directory, entry);
    if (EXCLUDED_DIRS.some((excluded) => entryPath.startsWith(excluded))) continue;
    if (statSync(entryPath).isDirectory()) {
      markdownFiles(entryPath, collected);
    } else if (entry.endsWith(".md")) {
      collected.push(entryPath);
    }
  }
  return collected;
}

function isExternal(link: string): boolean {
  // A leading slash is an application route (Astro content uses /docs/... and /blog/...),
  // not a repository-relative filesystem link.
  return /^(https?:|mailto:|\/)/.test(link);
}

/**
 * Blanks out fenced code blocks. Links inside a fence are illustrative sample content —
 * e.g. a doc showing what a SKILL.md looks like — not navigation, so they must not be
 * resolved. Line count is preserved so reported positions stay meaningful.
 */
function stripCodeFences(contents: string): string {
  let insideFence = false;
  return contents
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        insideFence = !insideFence;
        return "";
      }
      return insideFence ? "" : line;
    })
    .join("\n");
}

/** The visible text of inline heading tokens: emphasis markers and link targets dropped. */
function plainText(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      if (token.type === "html") {
        return "";
      }
      if ("tokens" in token && Array.isArray(token.tokens)) {
        return plainText(token.tokens);
      }
      return "text" in token && typeof token.text === "string" ? token.text : "";
    })
    .join("");
}

const EXPLICIT_ANCHOR_PATTERN = /\s(?:id|name)="([^"]+)"/g;

const anchorCache = new Map<string, ReadonlySet<string>>();

/** Every fragment a link may use to reach a place in this Markdown file. */
export function anchorsIn(markdown: string): ReadonlySet<string> {
  const slugger = new GithubSlugger();
  const anchors = new Set<string>();
  const body = matter(markdown).content;
  const visit = (tokens: readonly Token[]) => {
    for (const token of tokens) {
      if (token.type === "heading") {
        anchors.add(slugger.slug(plainText(token.tokens ?? [])));
      } else if (token.type !== "code" && "tokens" in token && Array.isArray(token.tokens)) {
        visit(token.tokens);
      }
      if (token.type === "list") {
        for (const item of (token as Tokens.List).items) {
          visit(item.tokens);
        }
      }
    }
  };
  visit(marked.lexer(body));
  for (const match of stripCodeFences(body).matchAll(EXPLICIT_ANCHOR_PATTERN)) {
    if (match[1] !== undefined) {
      anchors.add(match[1]);
    }
  }
  return anchors;
}

function anchorsOfFile(file: string): ReadonlySet<string> {
  const cached = anchorCache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const anchors = anchorsIn(readFileSync(file, "utf-8"));
  anchorCache.set(file, anchors);
  return anchors;
}

function main(): void {
  const tracked = trackedPaths();
  const trackedMarkdownSources = [...tracked].filter(
    (file) => file.endsWith(".md") && !EXCLUDED_DIRS.some((excluded) => file.startsWith(excluded)),
  );
  // Untracked new files are legitimate targets on a feature branch.
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
    encoding: "utf-8",
  })
    .stdout.split("\n")
    .filter((line) => line.length > 0);
  for (const file of untracked) tracked.add(file);

  const directories = new Set<string>();
  for (const trackedPath of tracked) {
    let parent = path.dirname(trackedPath);
    while (parent !== "." && parent !== "/") {
      directories.add(parent);
      parent = path.dirname(parent);
    }
  }

  // Check every tracked Markdown source: package and deployment READMEs are published
  // documentation too. Also include new docs/ files before their first commit, while skipping
  // unrelated untracked Markdown at the repository root.
  const files = [...new Set([...trackedMarkdownSources, ...markdownFiles("docs")])].sort();
  const broken: string[] = [];

  for (const file of files) {
    const contents = stripCodeFences(readFileSync(file, "utf-8"));
    const directory = path.dirname(file);
    for (const match of contents.matchAll(LINK_PATTERN)) {
      const link = match[1];
      if (link === undefined || isExternal(link)) continue;
      const [target = "", fragment] = link.split("#");
      const resolved = target.length === 0 ? file : path.normalize(path.join(directory, target));
      if (
        target.length > 0 &&
        !tracked.has(resolved) &&
        !directories.has(resolved.replace(/\/$/, ""))
      ) {
        broken.push(`${file} → ${link}`);
        continue;
      }
      if (fragment === undefined || fragment.length === 0 || !resolved.endsWith(".md")) continue;
      if (!anchorsOfFile(resolved).has(decodeURIComponent(fragment))) {
        broken.push(`${file} → ${link} (no heading or id "${fragment}")`);
      }
    }
  }

  if (broken.length > 0) {
    console.error(`✗ ${broken.length} broken link(s):\n`);
    for (const entry of broken) console.error(`  ${entry}`);
    console.error(
      "\nLinks are resolved against git-tracked paths (case-sensitive); fragments against the target's heading slugs.",
    );
    process.exit(1);
  }

  console.log(`✓ every relative link and anchor in ${files.length} Markdown files resolves`);
}

// eslint-disable-next-line n/no-unsupported-features/node-builtins -- Bun script entry point.
if (import.meta.main) {
  main();
}
