/**
 * The Ink side of the shared prompt pieces: a stepper line and a choice's description and tag.
 * What they say comes from `prompt-core`; this only styles it. Rows stay linear text so screen
 * readers read description and tag after the label, in that order.
 */

import type { PromptTagTone } from "@jazz/core/interfaces/terminal";
import { Box, Text } from "ink";
import React from "react";
import { getGlyphs } from "../glyphs";
import {
  STEP_SEPARATOR,
  stepText,
  stepperView,
  type PromptStepPosition,
} from "../prompt-core/stepper";
import {
  matchedSpan,
  plainDescription,
  suggestionOrigin,
  type SuggestionPrefix,
} from "../suggestion-menu";
import { THEME } from "../theme";

export function tagColor(tone: PromptTagTone | undefined): string {
  switch (tone) {
    case "success":
      return THEME.success;
    case "warning":
      return THEME.warning;
    case "accent":
      return THEME.primary;
    default:
      return THEME.muted;
  }
}

export function StepperLine({ step }: { readonly step: PromptStepPosition }): React.ReactElement {
  const check = getGlyphs().success;
  const view = stepperView(step);
  return (
    <Box>
      {view.items.map((item, index) => (
        <Text key={item.label}>
          {index > 0 ? <Text color={THEME.border}>{STEP_SEPARATOR}</Text> : null}
          <Text
            color={item.state === "current" ? THEME.primary : THEME.muted}
            bold={item.state === "current"}
          >
            {stepText(item, check)}
          </Text>
        </Text>
      ))}
      <Text color={THEME.muted}>{`  ${view.tally}`}</Text>
    </Box>
  );
}

export function ChoiceMeta({
  description,
  tag,
  tagTone,
}: {
  readonly description?: string | undefined;
  readonly tag?: string | undefined;
  readonly tagTone?: PromptTagTone | undefined;
}): React.ReactElement | null {
  if (!description && !tag) {
    return null;
  }
  return (
    <Text>
      {description ? <Text color={THEME.muted}>{`  ${description}`}</Text> : null}
      {tag ? <Text color={tagColor(tagTone)}>{`  ${tag}`}</Text> : null}
    </Text>
  );
}

export interface CommandSuggestionItemProps {
  readonly command: {
    readonly name: string;
    readonly description: string;
    readonly usage?: string | undefined;
    readonly source?: string | undefined;
  };
  readonly isSelected: boolean;
  /** Sigil the row completes: "/" for a command, "@" for a file path. */
  readonly prefix?: SuggestionPrefix;
  /** What is typed after the sigil; its letters are bold in the name. */
  readonly query?: string | undefined;
}

/** One row of the slash or `@` menu, shared by the chat prompt and home. */
export function CommandSuggestionItem({
  command,
  isSelected,
  prefix = "/",
  query,
}: CommandSuggestionItemProps): React.ReactElement {
  const span = matchedSpan(command.name, query ?? "");
  const origin = suggestionOrigin(command.source);
  return (
    <Box marginLeft={1}>
      <Text
        {...(isSelected ? { color: THEME.selected } : {})}
        bold={isSelected}
      >
        {isSelected ? "> " : "  "}
        {prefix}
        {span === undefined ? (
          command.name
        ) : (
          <>
            {command.name.slice(0, span[0])}
            <Text
              bold
              color={THEME.selected}
            >
              {command.name.slice(span[0], span[1])}
            </Text>
            {command.name.slice(span[1])}
          </>
        )}
      </Text>
      {command.usage ? <Text color={THEME.muted}> {command.usage}</Text> : null}
      {origin !== undefined ? <Text color={THEME.muted}> ({origin})</Text> : null}
      <Text dimColor> – {plainDescription(command.description)}</Text>
    </Box>
  );
}
