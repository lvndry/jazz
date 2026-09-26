/**
 * Paired coding task for ambient LSP. Both agents see the same project and use the
 * same weak model; only the variant enables the plugin in its private JAZZ_HOME.
 * The prompt never names LSP, so a useful diagnostic must reach the agent through
 * ordinary file work rather than a model-authored language-server tool call.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PluginRegistryServiceImpl, packPlugin } from "@jazz/adapters/plugins";
import { readJsonLines } from "../../files";
import { runJazzOnce } from "../../run-jazz";
import type { EvalTask, TaskRunContext } from "../../types";

const LSP_AGENT_ID = "eval-sut-lsp";
const LSP_PLUGIN_ID = "com.jazz.plugins.lsp";
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const PLUGIN_DIR = join(REPO_ROOT, "plugins", "lsp");
const SERVER_FILE = join(REPO_ROOT, "evals", "fixtures", "lsp", "receipt-server.ts");
const LSP_LOG = "lsp-synchronization.jsonl";

const moneySource = [
  "export function formatCents(cents: number): string {",
  "  return `$${(cents / 100).toFixed(2)}`;",
  "}",
  "",
  "export function formatMajorUnits(units: number): string {",
  "  return `$${units.toFixed(2)}`;",
  "}",
  "",
].join("\n");

const receiptSource = [
  'import { formatPrice } from "./money";',
  "",
  "export function renderReceipt(subtotalCents: number): string {",
  "  return `Total: ${formatPrice(subtotalCents)}`;",
  "}",
  "",
].join("\n");

const expectedReceipt = receiptSource
  .replace("formatPrice }", "formatCents }")
  .replace("formatPrice(subtotalCents)", "formatCents(subtotalCents)");

const prompt =
  "Make receipt.ts typecheck while preserving the receipt's displayed amount. " +
  "Read the relevant files, use edit_file for the fix, and leave unrelated code unchanged.";

/** Register only the variant's plugin through Jazz's real digest and consent registry. */
async function enableLsp(context: TaskRunContext): Promise<void> {
  const packed = await packPlugin({
    pluginDirectory: PLUGIN_DIR,
    releaseDirectory: join(context.jazzHome, "lsp-release"),
  });
  const registry = new PluginRegistryServiceImpl({
    pluginDirectory: join(context.jazzHome, "plugins"),
  });
  const added = await registry.add(packed.catalogEntryPath);
  if (!added.digest) throw new Error("LSP eval plugin install returned no digest");
  await registry.trust(LSP_PLUGIN_ID, added.digest);
  const inspection = await registry.inspect(LSP_PLUGIN_ID);
  await registry.grantConsent(LSP_PLUGIN_ID, inspection.consentDigest);
  await registry.enable(LSP_PLUGIN_ID, context.agentId);
}

function sawReceiptDiagnostic(logPath: string): boolean {
  return readJsonLines<{ uri?: string; diagnosticCount?: number }>(logPath).some(
    (record) => record.uri?.endsWith("/receipt.ts") === true && record.diagnosticCount === 1,
  );
}

export const tasks: EvalTask[] = [
  {
    id: "tooluse-ambient-lsp-receipt",
    domain: "tooluse",
    baseDifficulty: "medium",
    prompt,
    setup(workspaceDir) {
      writeFileSync(join(workspaceDir, "package.json"), '{"private":true,"type":"module"}\n');
      writeFileSync(
        join(workspaceDir, "tsconfig.json"),
        '{"compilerOptions":{"strict":true,"noEmit":true}}\n',
      );
      writeFileSync(join(workspaceDir, "money.ts"), moneySource);
      writeFileSync(join(workspaceDir, "receipt.ts"), receiptSource);
    },
    async run(context) {
      const isVariant = context.agentId === LSP_AGENT_ID;
      const logPath = join(context.jazzHome, LSP_LOG);
      if (isVariant) {
        await enableLsp(context);
      }
      const configPath = join(context.jazzHome, "lsp.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          servers: [
            {
              id: "receipt-eval",
              command: process.execPath,
              args: [SERVER_FILE, logPath],
              extensions: [".ts"],
              languageId: "typescript",
              rootMarkers: ["tsconfig.json"],
            },
          ],
        }),
      );
      const result = await runJazzOnce({
        prompt,
        agentId: context.agentId,
        workspaceDir: context.workspaceDir,
        cassettePath: context.cassettePath,
        timeoutMs: context.timeoutMs,
        runId: context.runId,
        jazzHome: context.jazzHome,
        environment: { ...context.environment, JAZZ_LSP_CONFIG: configPath },
      });
      if (isVariant && !sawReceiptDiagnostic(logPath))
        throw new Error("Ambient LSP never opened receipt.ts or published its diagnostic");
      return result;
    },
    check(result, workspaceDir) {
      const actual = readFileSync(join(workspaceDir, "receipt.ts"), "utf8");
      const moneyUnchanged = readFileSync(join(workspaceDir, "money.ts"), "utf8") === moneySource;
      const usedRead = result.toolCalls.some((call) => call.name === "read_file");
      const usedEdit = result.toolCalls.some((call) => call.name === "edit_file");
      const explicitLsp = result.toolCalls.some((call) =>
        call.name.startsWith("plugin_com_jazz_plugins_lsp_"),
      );
      const pass =
        actual === expectedReceipt && moneyUnchanged && usedRead && usedEdit && !explicitLsp;
      return {
        pass,
        score: pass ? 1 : 0,
        detail: `exact=${actual === expectedReceipt}, money unchanged=${moneyUnchanged}, read=${usedRead}, edit=${usedEdit}, explicit LSP=${explicitLsp}`,
      };
    },
  },
];
