/**
 * Operator-owned server configuration. Each entry selects a language by file
 * extension and an argv to spawn; the model only supplies a source-file path.
 * The LSP language ID is declared per extension — `.tsx` must open as
 * `typescriptreact`, not `typescript` — so one entry can no longer send two
 * dialects under a single language ID. Configuration is re-read for workspace
 * context and tool calls so a changed command takes effect on the next request.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

export interface ServerConfig {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Each file extension (with dot) maps to the LSP language ID opened for it. */
  readonly extensions: Readonly<Record<string, string>>;
  readonly rootMarkers: readonly string[];
}

export interface SelectedServer {
  readonly config: ServerConfig;
  readonly root: string;
  readonly path: string;
  readonly languageId: string;
}

export interface WorkspaceServer {
  readonly config: ServerConfig;
  readonly root: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Read ~/.jazz/lsp.json; reject malformed entries instead of launching an unintended command. */
export async function loadServers(): Promise<readonly ServerConfig[]> {
  const configPath = process.env["JAZZ_LSP_CONFIG"] ?? join(homedir(), ".jazz", "lsp.json");
  const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
  if (!record(parsed) || !Array.isArray(parsed["servers"]))
    throw new Error(`Invalid LSP configuration at ${configPath}: expected servers array`);
  return parsed["servers"].map((raw: unknown, index: number): ServerConfig => {
    const invalid = (detail: string): never => {
      throw new Error(`Invalid LSP server entry ${index} in ${configPath}: ${detail}`);
    };
    if (!record(raw)) return invalid("expected an object");
    const entry: Record<string, unknown> = raw;
    if (typeof entry["id"] !== "string") return invalid("id must be a string");
    if (typeof entry["command"] !== "string" || !entry["command"]) {
      return invalid("command must be a non-empty string");
    }
    if (
      !Array.isArray(entry["args"]) ||
      !entry["args"].every((arg: unknown) => typeof arg === "string")
    )
      return invalid("args must be an array of strings");
    if (typeof entry["languageId"] !== "undefined")
      return invalid("top-level languageId is unsupported; map each extension to its language ID");
    if (!record(entry["extensions"]) || Object.keys(entry["extensions"]).length === 0)
      return invalid(
        "extensions must be a non-empty object mapping each extension to a language ID",
      );
    const extensions: Record<string, string> = {};
    for (const [extension, languageId] of Object.entries(entry["extensions"])) {
      if (!extension.startsWith("."))
        return invalid(`extension ${JSON.stringify(extension)} must start with a dot`);
      if (!nonEmptyString(languageId))
        return invalid(`extension ${extension} must map to a non-empty language ID`);
      extensions[extension] = languageId;
    }
    if (
      !Array.isArray(entry["rootMarkers"]) ||
      !entry["rootMarkers"].every(
        (marker: unknown) => nonEmptyString(marker) && !marker.includes("/"),
      )
    )
      invalid("rootMarkers must be an array of non-empty filenames without slashes");
    return {
      id: entry["id"],
      command: entry["command"],
      args: entry["args"],
      extensions,
      rootMarkers: entry["rootMarkers"] as string[],
    };
  });
}

/** Resolve a source path from the agent cwd and choose the nearest configured project root. */
export async function selectServer(file: string, cwd: string): Promise<SelectedServer> {
  const path = await realpath(isAbsolute(file) ? file : resolve(cwd, file));
  const extension = extname(path);
  const servers = await loadServers();
  const config = servers.find((server) => extension in server.extensions);
  const languageId = config?.extensions[extension];
  if (config === undefined || languageId === undefined)
    throw new Error(
      `No configured LSP server for ${extension || path}. Configure ~/.jazz/lsp.json.`,
    );
  let root = dirname(path);
  while (true) {
    if (
      (
        await Promise.all(
          config.rootMarkers.map(async (marker) =>
            stat(join(root, marker)).then(
              () => true,
              () => false,
            ),
          ),
        )
      ).some(Boolean)
    )
      break;
    const parent = dirname(root);
    if (parent === root) {
      root = cwd;
      break;
    }
    root = parent;
  }
  return { config, root, path, languageId };
}

/** Select configured servers whose root markers identify the current workspace. */
export async function workspaceServers(cwd: string): Promise<readonly WorkspaceServer[]> {
  const configs = await loadServers();
  return (
    await Promise.all(
      configs.map(async (config): Promise<WorkspaceServer | undefined> => {
        let root = await realpath(cwd);
        while (true) {
          if (
            (
              await Promise.all(
                config.rootMarkers.map((marker) =>
                  stat(join(root, marker)).then(
                    () => true,
                    () => false,
                  ),
                ),
              )
            ).some(Boolean)
          )
            return { config, root };
          const parent = dirname(root);
          if (parent === root) return undefined;
          root = parent;
        }
      }),
    )
  ).filter((server): server is WorkspaceServer => server !== undefined);
}
