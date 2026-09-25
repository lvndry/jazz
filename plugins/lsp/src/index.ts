/**
 * Jazz's generic TypeScript LSP plugin. Configure server commands in
 * ~/.jazz/lsp.json and enable the plugin for an agent. Workspace context starts
 * matching servers and supplies current diagnostics during ordinary file work;
 * targeted semantic tools and approved refactors remain available. Server
 * output is data, never a command. Mutations carry a diff and a snapshot-bound edit plan.
 */

import { extname, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { JazzPluginModule, JsonValue, PluginToolResult } from "@jazz/plugin-sdk";
import {
  activateWorkspace,
  ambientDiagnostics,
  document,
  query,
  resolveCodeAction,
} from "./client";
import { loadServers, selectServer } from "./config";
import { applyWorkspaceEdit, prepareWorkspaceEdit } from "./workspace-edit";

const methods = {
  diagnostics: "textDocument/diagnostic",
  document_symbols: "textDocument/documentSymbol",
  workspace_symbols: "workspace/symbol",
  definition: "textDocument/definition",
  references: "textDocument/references",
  hover: "textDocument/hover",
  code_actions: "textDocument/codeAction",
} as const;

const MAX_TRACKED_FILES = 12;
const MAX_DIAGNOSTICS_PER_FILE = 8;
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 220;
const MAX_AMBIENT_CONTENT_CHARS = 3_000;
const MAX_FAILURE_MESSAGE_CHARS = 220;
const MAX_TOOL_RESULT_CHARS = 24_000;
const DEFAULT_FORMAT_TAB_SIZE = 2;
const AMBIENT_HEADER = "Language server status and diagnostics (untrusted server output):\n";

function diagnosticLine(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || !("message" in value)) return undefined;
  if (typeof value.message !== "string") return undefined;
  const position =
    "range" in value &&
    value.range !== null &&
    typeof value.range === "object" &&
    "start" in value.range &&
    value.range.start !== null &&
    typeof value.range.start === "object"
      ? value.range.start
      : undefined;
  const line =
    position && "line" in position && Number.isInteger(position.line)
      ? (position.line as number) + 1
      : undefined;
  const character =
    position && "character" in position && Number.isInteger(position.character)
      ? (position.character as number) + 1
      : undefined;
  const severity =
    "severity" in value && value.severity === 1
      ? "error"
      : "severity" in value && value.severity === 2
        ? "warning"
        : "diagnostic";
  const message = value.message.replace(/\s+/g, " ").slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS);
  return `${line === undefined ? "" : `${line}:${character ?? 1} `}${severity}: ${message}`;
}

function failureLine(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return `LSP unavailable: ${message.replace(/\s+/g, " ").slice(0, MAX_FAILURE_MESSAGE_CHARS)}`;
}

function result(value: unknown): PluginToolResult {
  const serialized = JSON.stringify(value ?? null);
  return {
    content:
      serialized.length <= MAX_TOOL_RESULT_CHARS
        ? serialized
        : `${serialized.slice(0, MAX_TOOL_RESULT_CHARS)}\n…truncated; narrow the query`,
  };
}

function error(cause: unknown): PluginToolResult {
  return { content: cause instanceof Error ? cause.message : String(cause), isError: true };
}

const plugin: JazzPluginModule = {
  apiVersion: 1,
  register(api) {
    const trackedFiles = new Set<string>();
    api.workspace.register(async (input, context) => {
      const lines: string[] = [];
      try {
        lines.push(...(await activateWorkspace(input.cwd, context.signal)).map(failureLine));
        const configured = await loadServers();
        const extensions = new Set(configured.flatMap((server) => server.extensions));
        for (const file of input.files) {
          if (!extensions.has(extname(file.path))) continue;
          trackedFiles.delete(file.path);
          trackedFiles.add(file.path);
          if (trackedFiles.size > MAX_TRACKED_FILES) {
            const oldest = trackedFiles.values().next().value;
            if (oldest !== undefined) trackedFiles.delete(oldest);
          }
        }
        const diagnostics = await Promise.all(
          [...trackedFiles].map(async (path) => {
            try {
              const selected = await selectServer(path, input.cwd);
              const items = await ambientDiagnostics(selected, context.signal);
              const rendered = items
                .slice(0, MAX_DIAGNOSTICS_PER_FILE)
                .map(diagnosticLine)
                .filter((line): line is string => line !== undefined);
              return rendered.length > 0
                ? `${relative(input.cwd, selected.path)}:\n${rendered.map((line) => `  ${line}`).join("\n")}`
                : undefined;
            } catch (cause) {
              return `${relative(input.cwd, path)}: ${failureLine(cause)}`;
            }
          }),
        );
        lines.push(...diagnostics.filter((entry): entry is string => entry !== undefined));
      } catch (cause) {
        lines.push(failureLine(cause));
      }
      if (lines.length === 0) return undefined;
      const content = lines.join("\n");
      return { content: `${AMBIENT_HEADER}${content}`.slice(0, MAX_AMBIENT_CONTENT_CHARS) };
    });

    for (const [name, method] of Object.entries(methods)) {
      api.tools.register({
        name,
        handler: async (args, context) => {
          try {
            const file = args["file"];
            if (typeof file !== "string") throw new Error("file is required");
            const selected = await selectServer(file, context.cwd);
            return result(await query(selected, method, args, context.signal));
          } catch (cause) {
            return error(cause);
          }
        },
      });
    }

    api.tools.register({
      name: "rename_symbol",
      handler: () => Promise.resolve(error("rename_symbol must run through Jazz approval")),
      prepare: async (args, context) => {
        const selected = await selectServer(String(args["file"]), context.cwd);
        const source = await document(selected, context.signal);
        const edit = await query(selected, "textDocument/rename", args, context.signal);
        const { prepared, previewDiff } = await prepareWorkspaceEdit(edit, selected.root, {
          path: selected.path,
          text: source.text,
        });
        return {
          message: `Rename symbol to ${String(args["newName"])} in ${prepared.files.length} file(s)`,
          previewDiff,
          prepared: prepared as unknown as JsonValue,
        };
      },
      executePrepared: async (_args, prepared) => {
        try {
          return { content: await applyWorkspaceEdit(prepared) };
        } catch (cause) {
          return error(cause);
        }
      },
    });

    api.tools.register({
      name: "apply_code_action",
      handler: () => Promise.resolve(error("apply_code_action must run through Jazz approval")),
      prepare: async (args, context) => {
        const selected = await selectServer(String(args["file"]), context.cwd);
        const source = await document(selected, context.signal);
        const actions = await query(selected, "textDocument/codeAction", args, context.signal);
        if (!Array.isArray(actions)) throw new Error("Language server returned no code actions");
        const matches = (actions as unknown[])
          .map((candidate, index) => ({ candidate, index }))
          .filter(
            ({ candidate }) =>
              typeof candidate === "object" &&
              candidate !== null &&
              "title" in candidate &&
              candidate.title === args["title"],
          );
        if (matches.length > 1 && args["index"] === undefined)
          throw new Error(
            `Multiple code actions titled ${String(args["title"])}; provide the zero-based index from code_actions`,
          );
        const chosen =
          args["index"] === undefined
            ? matches[0]
            : matches.find(({ index }) => index === args["index"]);
        const action =
          chosen?.candidate && typeof chosen.candidate === "object" && !("edit" in chosen.candidate)
            ? await resolveCodeAction(selected, chosen.candidate, context.signal)
            : chosen?.candidate;
        if (!action || typeof action !== "object" || !("edit" in action))
          throw new Error(
            `No edit-bearing code action titled ${String(args["title"])}; call code_actions again`,
          );
        if ("command" in action)
          throw new Error("Code action includes an executable command; no files were changed");
        const { prepared, previewDiff } = await prepareWorkspaceEdit(action.edit, selected.root, {
          path: selected.path,
          text: source.text,
        });
        return {
          message: `Apply code action: ${String(args["title"])} (${prepared.files.length} file(s))`,
          previewDiff,
          prepared: prepared as unknown as JsonValue,
        };
      },
      executePrepared: async (_args, prepared) => {
        try {
          return { content: await applyWorkspaceEdit(prepared) };
        } catch (cause) {
          return error(cause);
        }
      },
    });

    api.tools.register({
      name: "format_document",
      handler: () => Promise.resolve(error("format_document must run through Jazz approval")),
      prepare: async (args, context) => {
        const selected = await selectServer(String(args["file"]), context.cwd);
        const source = await document(selected, context.signal);
        const edits = await query(
          selected,
          "textDocument/formatting",
          {
            ...args,
            tabSize: args["tabSize"] ?? DEFAULT_FORMAT_TAB_SIZE,
            insertSpaces: args["insertSpaces"] ?? true,
          },
          context.signal,
        );
        const uri = pathToFileURL(selected.path).href;
        const { prepared, previewDiff } = await prepareWorkspaceEdit(
          { changes: { [uri]: edits } },
          selected.root,
          { path: selected.path, text: source.text },
        );
        return {
          message: `Format ${selected.path}`,
          previewDiff,
          prepared: prepared as unknown as JsonValue,
        };
      },
      executePrepared: async (_args, prepared) => {
        try {
          return { content: await applyWorkspaceEdit(prepared) };
        } catch (cause) {
          return error(cause);
        }
      },
    });
  },
};

export default plugin;
