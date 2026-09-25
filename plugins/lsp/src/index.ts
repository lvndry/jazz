/**
 * Jazz's generic TypeScript LSP plugin. Configure server commands in
 * ~/.jazz/lsp.json, enable the plugin for an agent, then call semantic read
 * tools or approved rename/code-action/format tools. Server output is data,
 * never a command. Mutations carry a diff and a snapshot-bound edit plan.
 */

import { pathToFileURL } from "node:url";
import type { JazzPluginModule, JsonValue, PluginToolResult } from "@jazz/plugin-sdk";
import { document, query, resolveCodeAction } from "./client";
import { selectServer } from "./config";
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

function result(value: unknown): PluginToolResult {
  const serialized = JSON.stringify(value ?? null);
  return {
    content:
      serialized.length <= 24_000
        ? serialized
        : `${serialized.slice(0, 24_000)}\n…truncated; narrow the query`,
  };
}

function error(cause: unknown): PluginToolResult {
  return { content: cause instanceof Error ? cause.message : String(cause), isError: true };
}

const plugin: JazzPluginModule = {
  apiVersion: 1,
  register(api) {
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
          { ...args, tabSize: args["tabSize"] ?? 2, insertSpaces: args["insertSpaces"] ?? true },
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
