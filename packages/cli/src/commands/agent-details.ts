/**
 * Build the read-only agent inspector shown from the wizard's agent list.
 * Only explicitly selected configuration fields are projected to the UI: API keys,
 * custom tool commands/responses, and URL credentials must never reach its store.
 */

import { isLocalServerProvider, isZeroCostLocalModel } from "@jazz/core/constants/local-providers";
import { isOllamaCloudModel } from "@jazz/core/constants/ollama";
import type { Agent } from "@jazz/core/types/agent";
import { formatModelPriceLine } from "@jazz/core/utils/model-capabilities";
import type { ModelsDevMetadata } from "@jazz/core/utils/models-dev";
import { formatReasoningSelection } from "../helpers/reasoning";
import type { ActiveAgentDetails } from "../ui/store";

type Field = ActiveAgentDetails["fields"][number];

function list(values: readonly string[] | undefined): string {
  return values === undefined || values.length === 0 ? "none" : values.join(", ");
}

function safeHostUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "unavailable";
  }
}

/** Prices are per million tokens; unpriced cloud models stay explicitly unknown. */
function priceFields(agent: Agent, metadata: ModelsDevMetadata | undefined): readonly Field[] {
  const prices = isZeroCostLocalModel(agent.config.llmProvider, agent.config.llmModel)
    ? { inputPricePerMillion: 0, outputPricePerMillion: 0 }
    : (metadata ?? {});
  return [
    {
      section: "Model",
      label: "Input price",
      value: formatModelPriceLine(
        prices.inputPricePerMillion === undefined
          ? {}
          : { inputPricePerMillion: prices.inputPricePerMillion },
      ).replace("/M in", "/M tokens"),
    },
    {
      section: "Model",
      label: "Output price",
      value: formatModelPriceLine(
        prices.outputPricePerMillion === undefined
          ? {}
          : { outputPricePerMillion: prices.outputPricePerMillion },
      ).replace("/M out", "/M tokens"),
    },
  ];
}

/** Shape a stored agent and resolved model metadata into visible, nonsecret rows. */
export function agentDetailFields(
  agent: Agent,
  metadata: ModelsDevMetadata | undefined,
  resolvedHostUrl?: string,
): readonly Field[] {
  const config = agent.config;
  const fields: Field[] = [
    { section: "Identity", label: "ID", value: agent.id },
    { section: "Identity", label: "Name", value: agent.name },
    { section: "Identity", label: "Description", value: agent.description?.trim() || "none" },
    { section: "Identity", label: "Created", value: agent.createdAt.toISOString() },
    { section: "Identity", label: "Updated", value: agent.updatedAt.toISOString() },
    { section: "Model", label: "Provider", value: config.llmProvider },
    { section: "Model", label: "Model", value: config.llmModel },
    { section: "Model", label: "Reasoning", value: formatReasoningSelection(config.reasoning) },
    ...priceFields(agent, metadata),
  ];
  if (
    isLocalServerProvider(config.llmProvider) &&
    (config.llmProvider !== "ollama" || !isOllamaCloudModel(config.llmModel))
  ) {
    fields.push({
      section: "Model",
      label: "Host URL",
      value: resolvedHostUrl ? safeHostUrl(resolvedHostUrl) : "unavailable",
    });
  }
  fields.push(
    { section: "Model", label: "Summarizer", value: config.summarizerModel ?? "primary model" },
    { section: "Model", label: "Persona", value: config.persona },
    {
      section: "Model",
      label: "Temperature",
      value: config.temperature?.toString() ?? "provider default",
    },
    {
      section: "Model",
      label: "Context limit",
      value: config.maxContextTokens?.toLocaleString() ?? "model default",
    },
  );
  if (config.llmProvider === "ollama") {
    fields.push({
      section: "Model",
      label: "Ollama num_ctx",
      value: config.numCtx?.toLocaleString() ?? "server default",
    });
  }
  fields.push(
    { section: "Access", label: "Tools added", value: list(config.tools) },
    { section: "Access", label: "Tools denied", value: list(config.deniedTools) },
    { section: "Access", label: "Web search", value: config.webSearchProvider ?? "default" },
    { section: "Access", label: "Memory scopes", value: list(config.memoryScopes ?? ["personal"]) },
    { section: "Access", label: "Env allowlist", value: list(config.envAllowlist) },
  );
  const companions = Object.entries(config.companions ?? {});
  for (const [role, model] of companions) {
    fields.push({ section: "Companions", label: role, value: model });
  }
  if (companions.length === 0)
    fields.push({ section: "Companions", label: "Models", value: "none" });
  for (const tool of config.customTools ?? []) {
    fields.push({
      section: "Custom tools",
      label: tool.name,
      value: `${tool.handler.type} · ${tool.description}`,
    });
  }
  if ((config.customTools?.length ?? 0) === 0)
    fields.push({ section: "Custom tools", label: "Tools", value: "none" });
  if (config.llmApiKeys !== undefined && Object.keys(config.llmApiKeys).length > 0) {
    fields.push({ section: "Credentials", label: "Agent API keys", value: "configured (hidden)" });
  }
  return fields;
}
