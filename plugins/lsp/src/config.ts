/**
 * Operator-owned server configuration. Each entry selects a language by file
 * extension and an argv to spawn; the model only supplies a source-file path.
 * Configuration is re-read for workspace context and tool calls so a changed
 * command takes effect on the next request.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

export interface ServerConfig {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly extensions: readonly string[];
  readonly languageId: string;
  readonly rootMarkers: readonly string[];
}

export interface SelectedServer {
  readonly config: ServerConfig;
  readonly root: string;
  readonly path: string;
}

export interface WorkspaceServer {
  readonly config: ServerConfig;
  readonly root: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read ~/.jazz/lsp.json; reject malformed entries instead of launching an unintended command. */
export async function loadServers(): Promise<readonly ServerConfig[]> {
  const configPath = process.env["JAZZ_LSP_CONFIG"] ?? join(homedir(), ".jazz", "lsp.json");
  const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
  if (!record(parsed) || !Array.isArray(parsed["servers"]))
    throw new Error(`Invalid LSP configuration at ${configPath}: expected servers array`);
  return parsed["servers"].map((entry: unknown, index: number): ServerConfig => {
    if (
      !record(entry) ||
      typeof entry["id"] !== "string" ||
      typeof entry["command"] !== "string" ||
      !entry["command"] ||
      !Array.isArray(entry["args"]) ||
      !entry["args"].every((arg: unknown) => typeof arg === "string") ||
      !Array.isArray(entry["extensions"]) ||
      !entry["extensions"].every(
        (extension: unknown) => typeof extension === "string" && extension.startsWith("."),
      ) ||
      typeof entry["languageId"] !== "string" ||
      !Array.isArray(entry["rootMarkers"]) ||
      !entry["rootMarkers"].every(
        (marker: unknown) =>
          typeof marker === "string" && marker.length > 0 && !marker.includes("/"),
      )
    )
      throw new Error(`Invalid LSP server entry ${index} in ${configPath}`);
    return {
      id: entry["id"],
      command: entry["command"],
      args: entry["args"],
      extensions: entry["extensions"] as string[],
      languageId: entry["languageId"],
      rootMarkers: entry["rootMarkers"] as string[],
    };
  });
}

/** Resolve a source path from the agent cwd and choose the nearest configured project root. */
export async function selectServer(file: string, cwd: string): Promise<SelectedServer> {
  const path = await realpath(isAbsolute(file) ? file : resolve(cwd, file));
  const servers = await loadServers();
  const config = servers.find((server) => server.extensions.includes(extname(path)));
  if (!config)
    throw new Error(
      `No configured LSP server for ${extname(path) || path}. Configure ~/.jazz/lsp.json.`,
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
  return { config, root, path };
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
