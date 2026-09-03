/**
 * @fileoverview Media capabilities: which models can see, hear, watch, and make.
 *
 * An agent whose own model is text-only hits a wall the moment the work involves an
 * image, a recording, or a clip. Rather than dead-ending, it delegates to a *model
 * companion*: an ephemeral run on any available model that can do the job, chosen by
 * the human from a picker (or pre-bound as a standing companion for unattended runs).
 *
 * This module is the shared vocabulary for that flow:
 * - {@link MediaModality} — the three media kinds worth delegating. PDF is deliberately
 *   absent: every text agent reads PDFs through `read_pdf`, so there is nothing to
 *   delegate.
 * - {@link modelSupportsRole} — whether a model can do one `<action>:<modality>` job.
 * - {@link filterCapableModels} — narrows a provider's model list to candidates.
 * - {@link formatModelPriceLine} — the per-row price text pickers show, with the
 *   house convention of saying "unknown" rather than inventing $0.
 */

import type { CompanionRole, ModelInfo } from "@/core/types/llm";
import { parseCompanionRole } from "@/core/types/llm";

export {
  COMPANION_ROLES,
  MEDIA_ACTIONS,
  MEDIA_MODALITIES,
  companionRole,
  isCompanionRole,
  isMediaModality,
  parseCompanionRole,
  type CompanionRole,
  type MediaAction,
  type MediaModality,
} from "@/core/types/llm";

/** Human phrase for a role, used in prompts and picker copy. */
export function describeRole(role: CompanionRole): string {
  const { action, modality } = parseCompanionRole(role);
  return action === "analyze" ? `${modality} understanding` : `${modality} generation`;
}

/**
 * The six capability flags a catalog reports, as the shape every source shares.
 *
 * `ModelInfo` and `ModelsDevMetadata` both carry these names — the first optional, the
 * second required — so one probe reads either without converting between them.
 */
export type ModalityFlags = Partial<
  Pick<
    ModelInfo,
    | "ingestImage"
    | "ingestAudio"
    | "ingestVideo"
    | "generatesImage"
    | "generatesAudio"
    | "generatesVideo"
  >
>;

const ROLE_FLAGS: Readonly<Record<CompanionRole, keyof ModalityFlags>> = {
  "analyze:image": "ingestImage",
  "analyze:audio": "ingestAudio",
  "analyze:video": "ingestVideo",
  "generate:image": "generatesImage",
  "generate:audio": "generatesAudio",
  "generate:video": "generatesVideo",
};

/** Whether this model can do the role itself, per catalog metadata. Absent means no. */
export function modelSupportsRole(model: ModalityFlags, role: CompanionRole): boolean {
  return model[ROLE_FLAGS[role]] === true;
}

/** One delegatable model: what the picker shows and what the child run runs on. */
export interface CapableModel {
  /** Provider identifier, e.g. "anthropic". */
  readonly provider: string;
  /** Model id within the provider, e.g. "claude-sonnet-4-5". */
  readonly modelId: string;
  readonly displayName?: string;
  /** USD per 1M input tokens. Absent when the catalog does not price this model. */
  readonly inputPricePerMillion?: number;
  /** USD per 1M output tokens. Absent when the catalog does not price this model. */
  readonly outputPricePerMillion?: number;
}

/**
 * The models in `models` that can do `role`, best first.
 *
 * Unpriced models sort after priced ones at equal footing — not because they are
 * worse, but because when everything else is comparable the one whose cost you can
 * predict is the safer default. Within each group, cheaper input price wins, then id,
 * so the order is stable across invocations.
 */
export function filterCapableModels(
  models: readonly ModelInfo[],
  role: CompanionRole,
): CapableModel[] {
  const capable: (CapableModel & { readonly priced: boolean })[] = [];
  for (const model of models) {
    if (!modelSupportsRole(model, role)) continue;
    const priced =
      model.inputPricePerMillion !== undefined || model.outputPricePerMillion !== undefined;
    capable.push({
      provider: "",
      modelId: model.id,
      ...(model.displayName !== undefined && { displayName: model.displayName }),
      ...(model.inputPricePerMillion !== undefined && {
        inputPricePerMillion: model.inputPricePerMillion,
      }),
      ...(model.outputPricePerMillion !== undefined && {
        outputPricePerMillion: model.outputPricePerMillion,
      }),
      priced,
    });
  }
  return capable
    .sort((left, right) => {
      if (left.priced !== right.priced) return left.priced ? -1 : 1;
      const byInputPrice =
        (left.inputPricePerMillion ?? Number.POSITIVE_INFINITY) -
        (right.inputPricePerMillion ?? Number.POSITIVE_INFINITY);
      if (byInputPrice !== 0) return byInputPrice;
      return left.modelId.localeCompare(right.modelId);
    })
    .map(({ priced: _priced, ...capableModel }) => capableModel);
}

/**
 * Price line for a picker row: `"$3/M in · $15/M out"` or `"price unknown"`.
 *
 * Never fabricates a zero — an unknown price must read as unknown, matching how run
 * costs report `costKnown: false` rather than `$0`.
 */
export function formatModelPriceLine(
  model: Pick<CapableModel, "inputPricePerMillion" | "outputPricePerMillion">,
): string {
  if (model.inputPricePerMillion === undefined && model.outputPricePerMillion === undefined) {
    return "price unknown";
  }
  const parts: string[] = [];
  if (model.inputPricePerMillion !== undefined) {
    parts.push(`$${trimNumber(model.inputPricePerMillion)}/M in`);
  }
  if (model.outputPricePerMillion !== undefined) {
    parts.push(`$${trimNumber(model.outputPricePerMillion)}/M out`);
  }
  return parts.join(" · ");
}

function trimNumber(value: number): string {
  return String(Number(value.toFixed(2)));
}

/**
 * One-line summary of a model for picker rows: what goes in on the left of the
 * arrow, what comes out on the right, each with its per-Mtok price.
 *
 * ```
 * txt·img $4/M → txt $20/M
 * ```
 *
 * `txt` is always present on both sides because everything listed here converses;
 * an unpriced side reads `?/M` rather than pretending to be free.
 */
export function describeModelCapabilities(
  model: Pick<
    ModelInfo,
    | "ingestImage"
    | "ingestPdf"
    | "ingestAudio"
    | "ingestVideo"
    | "generatesImage"
    | "generatesAudio"
    | "generatesVideo"
    | "inputPricePerMillion"
    | "outputPricePerMillion"
  >,
): string {
  const inputs = ["txt"];
  if (model.ingestImage === true) inputs.push("img");
  if (model.ingestAudio === true) inputs.push("aud");
  if (model.ingestVideo === true) inputs.push("vid");
  if (model.ingestPdf === true) inputs.push("pdf");

  const outputs = ["txt"];
  if (model.generatesImage === true) outputs.push("img");
  if (model.generatesAudio === true) outputs.push("aud");
  if (model.generatesVideo === true) outputs.push("vid");

  const inputPrice =
    model.inputPricePerMillion !== undefined
      ? `$${trimNumber(model.inputPricePerMillion)}/M`
      : "?/M";
  const outputPrice =
    model.outputPricePerMillion !== undefined
      ? `$${trimNumber(model.outputPricePerMillion)}/M`
      : "?/M";

  return `${inputs.join("·")} ${inputPrice} → ${outputs.join("·")} ${outputPrice}`;
}
