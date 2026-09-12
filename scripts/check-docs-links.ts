/**
 * Verifies every relative Markdown link in published Markdown resolves.
 *
 * Resolution is deliberately case-sensitive even on macOS: links are checked against the
 * paths git actually tracks, because that is what GitHub and Linux checkouts serve. A link
 * to `docs/SECURITY.md` when git tracks `docs/security.md` works locally and 404s in
 * production, so the filesystem is the wrong oracle here.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Local-only plans; gitignored, so their links are not part of the published docs. */
const EXCLUDED_DIRS = ["docs/superpowers"];

const LINK_PATTERN = /\]\(([^)]+)\)/g;

function trackedPaths(): Set<string> {
  const result = spawnSync("git", ["ls-files"], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr}`);
  }
  const paths = new Set(result.stdout.split("\n").filter((line) => line.length > 0));

  // `git ls-files` includes tracked files deleted in the working tree. During a docs move that
  // made links to the old path look valid until after commit, exactly when the check is meant to
  // catch them. Preserve git as the case-sensitive path oracle, but remove unstaged deletions.
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
  return /^(https?:|mailto:|#|\/)/.test(link);
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
      const target = link.split("#")[0];
      if (target === undefined || target.length === 0) continue;
      const resolved = path.normalize(path.join(directory, target));
      if (tracked.has(resolved) || directories.has(resolved.replace(/\/$/, ""))) continue;
      broken.push(`${file} → ${link}`);
    }
  }

  if (broken.length > 0) {
    console.error(`✗ ${broken.length} broken link(s):\n`);
    for (const entry of broken) console.error(`  ${entry}`);
    console.error("\nLinks are resolved against git-tracked paths (case-sensitive).");
    process.exit(1);
  }

  console.log(`✓ every relative link in ${files.length} Markdown files resolves`);
}

main();
