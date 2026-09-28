/**
 * The home screen for the Ink renderer: screen readers, terminals too small for fullscreen, and
 * `--no-tui`. Content comes from the shared home model; this lays it out as a list a screen
 * reader walks top to bottom, where arrows and enter pick a row and the single keys of the
 * fullscreen legend work too.
 */

import { Box, Text, useInput } from "ink";
import React from "react";
import { ScrollableSelect } from "./components/ScrollableSelect";
import { getGlyphs } from "./glyphs";
import {
  FIRST_RUN_PITCH,
  FIRST_RUN_PROMISE,
  FIRST_RUN_SETUP_LEAD,
  FIRST_RUN_STEPS,
  conversationTag,
  detectionLines,
  homeLead,
  statusText,
  type HomeModel,
} from "./models/home-view";
import { PICKER_WINDOW_SIZE } from "./picker-window";
import { THEME } from "./theme";

export interface InkHomeProps {
  readonly model: HomeModel;
  readonly onSelect: (value: string) => void;
  readonly onExit: () => void;
}

/** Every row in reading order: conversations first, then the actions, each labelled with its key. */
export function inkHomeOptions(
  model: HomeModel,
): readonly { readonly label: string; readonly value: string }[] {
  return [
    ...model.conversations.map((conversation) => ({
      label: `${conversation.key}  ${conversation.title} · ${conversation.agent} · ${conversationTag(conversation)}`,
      value: conversation.value,
    })),
    ...model.actions.map((action) => ({
      label: `${action.key === "enter" ? "↵" : action.key}  ${action.label}`,
      value: action.value,
    })),
  ];
}

export function InkHome({ model, onSelect, onExit }: InkHomeProps): React.ReactElement {
  const glyphs = getGlyphs();
  const lead = homeLead(model);
  const status = statusText(model.status, ` ${glyphs.bullet} `);
  const options = inkHomeOptions(model);

  useInput((input, key) => {
    if (key.escape) {
      onExit();
      return;
    }
    if (key.ctrl || key.meta || key.return || input.length !== 1) {
      return;
    }
    const target =
      model.actions.find((action) => action.key === input) ??
      model.conversations.find((conversation) => conversation.key === input);
    if (target !== undefined) onSelect(target.value);
  });

  return (
    <Box
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <Text>
        <Text color={THEME.primary}>{glyphs.note}</Text>
        <Text bold> jazz</Text>
        <Text color={THEME.muted}>{`  ${model.version}`}</Text>
      </Text>
      {model.firstRun === undefined ? (
        model.greeting.length > 0 && (
          <Box marginTop={1}>
            <Text>
              {model.greeting}
              {lead.length > 0 ? <Text color={THEME.secondary}>{` ${lead}`}</Text> : null}
            </Text>
          </Box>
        )
      ) : (
        <Box
          marginTop={1}
          flexDirection="column"
        >
          <Text>{FIRST_RUN_PITCH}</Text>
          <Text color={THEME.secondary}>{FIRST_RUN_PROMISE}</Text>
          <Text color={THEME.muted}>
            {`${FIRST_RUN_SETUP_LEAD} ${FIRST_RUN_STEPS.map((step, index) => `${String(index + 1)} ${step}`).join(", ")}`}
          </Text>
          {detectionLines(model).map((line) => (
            <Text
              key={line.label}
              color={THEME.success}
            >
              {`${line.lead} `}
              <Text bold>{line.label}</Text>
              {` ${line.detail}`}
            </Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <ScrollableSelect
          // The picker keeps the options it mounted with; the conversations arrive in a refresh,
          // so a new option set remounts it.
          key={options.map((option) => option.value).join("|")}
          options={options}
          pageSize={PICKER_WINDOW_SIZE}
          onSelect={(value) => onSelect(String(value))}
          onCancel={onExit}
        />
      </Box>
      {status.length > 0 && (
        <Box marginTop={1}>
          <Text color={THEME.muted}>{status}</Text>
        </Box>
      )}
    </Box>
  );
}
