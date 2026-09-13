/**
 * Defines the semantic layers of a Jazz system prompt and renders them in
 * precedence order. Core holds agent identity and fixed harness behavior,
 * Scope holds task or workspace instructions, and Live holds runtime facts
 * that may change while the agent is running.
 */

export interface PromptSection {
  readonly id: string;
  readonly content: string;
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
