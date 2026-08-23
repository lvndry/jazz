import path from "node:path";

interface MarkdownNode {
  type?: string;
  url?: string;
  children?: MarkdownNode[];
}

interface Options {
  /** Absolute path to the repo's docs/ directory. */
  docsRoot: string;
  /** GitHub repository URL, no trailing slash. */
  repoUrl: string;
  /** Branch that GitHub links point at. Defaults to "main". */
  branch?: string;
}

const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;

function walk(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/**
 * The docs are written for GitHub: relative links between .md files, and
 * relative links up into the repo (../README.md, ../../src/…). On the site,
 * in-docs links become routes and everything else points at GitHub, so no
 * link an author wrote on GitHub ever 404s here.
 */
export function remarkDocsLinks(options: Options) {
  const { docsRoot, repoUrl, branch = "main" } = options;
  const repoRoot = path.dirname(docsRoot);

  const rewrite = (url: string, fromDir: string): string => {
    if (url === "" || url.startsWith("#") || url.startsWith("/") || EXTERNAL.test(url)) {
      return url;
    }
    const [target = "", anchor] = url.split("#", 2);
    const suffix = anchor ? `#${anchor}` : "";
    const resolved = path.resolve(fromDir, decodeURI(target));
    const inDocs = path.relative(docsRoot, resolved);

    if (!inDocs.startsWith("..") && inDocs.endsWith(".md")) {
      const slug = inDocs
        .slice(0, -".md".length)
        .split(path.sep)
        .join("/")
        .replace(/\/index$/, "")
        .replace(/^index$/, "");
      return slug === "" ? `/docs${suffix}` : `/docs/${slug}${suffix}`;
    }

    const inRepo = path.relative(repoRoot, resolved);
    if (inRepo.startsWith("..")) return url;
    const repoPath = inRepo.split(path.sep).join("/");
    const kind = target.endsWith("/") ? "tree" : "blob";
    return `${repoUrl}/${kind}/${branch}/${repoPath}${suffix}`;
  };

  return (tree: MarkdownNode, file: { path?: string }): void => {
    const fromDir = file.path ? path.dirname(file.path) : docsRoot;
    walk(tree, (node) => {
      if (
        (node.type === "link" || node.type === "definition" || node.type === "image") &&
        typeof node.url === "string"
      ) {
        node.url = rewrite(node.url, fromDir);
      }
    });
  };
}
