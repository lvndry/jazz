/**
 * Defines the semantic layers of a Jazz system prompt and renders them in
 * precedence order. Core holds agent identity and fixed harness behavior,
 * Scope holds task or workspace instructions, and Live holds runtime facts
 * that may change while the agent is running.
 */

export interface PromptSection {
  readonly id: string;
  readonly content: string;
  /** True when the text is identical on every turn of a conversation. */
  readonly stable?: true;
}

export interface PromptLayers {
  readonly core: readonly PromptSection[];
  readonly scope: readonly PromptSection[];
  readonly live: readonly PromptSection[];
}

/** Join non-empty prompt sections as Core, then Scope, then Live. */
export function renderPromptLayers(layers: PromptLayers): string {
  return [...layers.core, ...layers.scope, ...layers.live]
    .map((section) => section.content.trim())
    .filter((content) => content.length > 0)
    .join("\n\n");
}

export interface RenderedPromptLayers {
  readonly text: string;
  /**
   * Length of the leading span of `text` made only of stable sections. The remainder begins at the
   * separator that follows it, so `text.slice(0, n) + text.slice(n)` is `text`. Absent when no
   * leading span is stable or nothing follows it.
   */
  readonly stablePrefixLength?: number;
}

const SECTION_SEPARATOR = "\n\n";

/**
 * Render exactly as `renderPromptLayers` and also report where the stable prefix ends, so a
 * provider with prefix caching can place a cache breakpoint there.
 */
export function renderPromptLayersWithStablePrefix(layers: PromptLayers): RenderedPromptLayers {
  const rendered = [...layers.core, ...layers.scope, ...layers.live]
    .map((section) => ({ stable: section.stable === true, content: section.content.trim() }))
    .filter((section) => section.content.length > 0);

  const stableCount = rendered.findIndex((section) => !section.stable);
  const leadingStable = stableCount === -1 ? rendered.length : stableCount;
  const text = rendered.map((section) => section.content).join(SECTION_SEPARATOR);

  if (leadingStable === 0 || leadingStable === rendered.length) {
    return { text };
  }
  const stablePrefixLength = rendered
    .slice(0, leadingStable)
    .map((section) => section.content)
    .join(SECTION_SEPARATOR).length;
  return { text, stablePrefixLength };
}
