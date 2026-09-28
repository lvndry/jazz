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
