/**
 * Every environment variable Jazz reads is listed in `docs/configure/environment-variables.md`.
 *
 * Collected from the code rather than a hand list: each `JAZZ_*` string literal in package and
 * plugin source (a template head such as `JAZZ_PEER_TOKEN_${name}` counts as its prefix), each
 * `$JAZZ_*` a shipped shell script reads, and every provider key, key alias, web search key and
 * local server URL variable in the registries that resolve them. A variable that only the tests
 * or the eval harness read is listed in `NOT_USER_FACING` with the reason.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  LLM_PROVIDER_ENV_VAR_ALIASES,
  LLM_PROVIDER_ENV_VARS,
  SECRET_ENV_VARS,
} from "@jazz/adapters/secrets/registry";
import { LOCAL_SERVER_PROVIDERS } from "@jazz/core/constants/local-providers";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const REPO_ROOT = path.join(import.meta.dir, "..");
const PAGE = path.join(REPO_ROOT, "docs", "configure", "environment-variables.md");

/** Names that look like variables in source but are not something a user sets. */
const NOT_USER_FACING: Readonly<Record<string, string>> = {
  JAZZ_SUMMARY: "a marker printed before a workflow run's JSON summary line",
  JAZZ_WEB_CASSETTE: "eval harness: records or replays web requests",
  JAZZ_WEB_MODE: "eval harness: cassette record or replay mode",
};

const NAME_PATTERN = /^JAZZ_[A-Z0-9_]+$/;
const SHELL_READ_PATTERN = /\$\{?(JAZZ_[A-Z0-9_]+)/g;

function sourceFiles(directory: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (entry === "node_modules" || entry === "dist") {
      continue;
    }
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full, extensions));
    } else if (
      extensions.some((extension) => entry.endsWith(extension)) &&
      !/\.test\.tsx?$/.test(entry)
    ) {
      found.push(full);
    }
  }
  return found;
}

function sourceRoots(): string[] {
  return ["packages", "plugins"].flatMap((parent) =>
    readdirSync(path.join(REPO_ROOT, parent))
      .map((name) => path.join(REPO_ROOT, parent, name, "src"))
      .filter((root) => {
        try {
          return statSync(root).isDirectory();
        } catch {
          return false;
        }
      }),
  );
}

function namesInTypeScript(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest);
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      NAME_PATTERN.test(node.text)
    ) {
      names.push(node.text);
    } else if (ts.isTemplateHead(node) && NAME_PATTERN.test(node.text)) {
      names.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function namesInShell(file: string): string[] {
  return [...readFileSync(file, "utf-8").matchAll(SHELL_READ_PATTERN)].map(
    (match) => match[1] ?? "",
  );
}

function variablesJazzReads(): Set<string> {
  const names = new Set<string>();
  for (const root of sourceRoots()) {
    for (const file of sourceFiles(root, [".ts", ".tsx"])) {
      for (const name of namesInTypeScript(file)) {
        names.add(name);
      }
    }
    for (const file of sourceFiles(root, [".sh"])) {
      for (const name of namesInShell(file)) {
        names.add(name);
      }
    }
  }
  for (const name of namesInShell(path.join(REPO_ROOT, "scripts", "install.sh"))) {
    names.add(name);
  }
  for (const name of [
    ...Object.values(LLM_PROVIDER_ENV_VARS),
    ...Object.values(LLM_PROVIDER_ENV_VAR_ALIASES).flat(),
    ...Object.values(SECRET_ENV_VARS),
    ...Object.values(LOCAL_SERVER_PROVIDERS).map((provider) => provider.envVar),
  ]) {
    names.add(name);
  }
  return names;
}

describe("environment variable reference", () => {
  const page = readFileSync(PAGE, "utf-8");
  const names = variablesJazzReads();

  it("finds the variables it is meant to check", () => {
    expect(names.has("JAZZ_HOME")).toBe(true);
    expect(names.has("OPENAI_API_KEY")).toBe(true);
    expect(names.has("JAZZ_INSTALL_DIR")).toBe(true);
    expect(names.has("JAZZ_DEPLOY_BRANCH")).toBe(true);
  });

  it("lists every variable Jazz reads", () => {
    const missing = [...names]
      .filter((name) => NOT_USER_FACING[name] === undefined)
      .filter((name) => !page.includes(name))
      .sort();
    expect(missing).toEqual([]);
  });
});
