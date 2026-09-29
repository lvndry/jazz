import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";

const CLI_SOURCE = path.resolve(import.meta.dir, "..");
const EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];
const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};

function resolveLocal(specifier: string, importer: string): string | null {
  let base: string;
  if (specifier.startsWith("@/cli/")) {
    base = path.join(CLI_SOURCE, specifier.slice("@/cli/".length));
  } else if (specifier.startsWith("@jazz/cli/")) {
    base = path.join(CLI_SOURCE, specifier.slice("@jazz/cli/".length));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(importer), specifier);
  } else {
    return null;
  }
  for (const extension of ["", ...EXTENSIONS]) {
    const candidate = base + extension;
    if (existsSync(candidate) && !candidate.endsWith("/")) {
      if (extension === "" && !/\.tsx?$/.test(candidate)) {
        continue;
      }
      return candidate;
    }
  }
  return null;
}

/** Every package a module loads at runtime, following local imports; type-only imports are erased. */
function runtimePackages(entry: string): { packages: Set<string>; chains: Map<string, string> } {
  const packages = new Set<string>();
  const chains = new Map<string, string>();
  const seen = new Set<string>();
  const queue: { file: string; chain: string }[] = [
    { file: entry, chain: path.relative(CLI_SOURCE, entry) },
  ];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || seen.has(next.file)) {
      continue;
    }
    seen.add(next.file);
    const transpiler = next.file.endsWith(".tsx") ? transpilers.tsx : transpilers.ts;
    const imports = transpiler.scanImports(readFileSync(next.file, "utf8"));
    for (const imported of imports) {
      if (imported.kind === "dynamic-import" || imported.kind === "require-call") {
        continue;
      }
      const local = resolveLocal(imported.path, next.file);
      if (local !== null) {
        queue.push({ file: local, chain: `${next.chain} → ${path.relative(CLI_SOURCE, local)}` });
      } else if (!imported.path.startsWith(".") && !imported.path.startsWith("@/")) {
        packages.add(imported.path);
        if (!chains.has(imported.path)) {
          chains.set(imported.path, next.chain);
        }
      }
    }
  }
  return { packages, chains };
}

describe("the Ink renderer's import graph", () => {
  const entries = ["ui/App.tsx", "terminal.ts", "presentation/ink-presentation-service.ts"];

  for (const entry of entries) {
    it(`never loads OpenTUI from ${entry}`, () => {
      const { packages, chains } = runtimePackages(path.join(CLI_SOURCE, entry));
      const openTui = [...packages].filter((name) => name.startsWith("@opentui/"));
      expect(openTui.map((name) => `${name} via ${chains.get(name) ?? "?"}`)).toEqual([]);
    });
  }

  it("still reaches Ink, so the walk is following real imports", () => {
    const { packages } = runtimePackages(path.join(CLI_SOURCE, "ui/App.tsx"));
    expect(packages.has("ink")).toBe(true);
  });
});
