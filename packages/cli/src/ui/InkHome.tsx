/**
 * The home screen for the Ink renderer: screen readers, terminals too small for fullscreen, and
 * `--no-tui`. It reads top to bottom as complete sentences from the shared home model, and the
 * keys mean what they mean on the fullscreen home, because both ask `homeIntent`.
 */

import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import { CommandSuggestionItem } from "./components/PromptParts";
import {
  COMPOSER_PLACEHOLDER,
  FIRST_RUN_PITCH,
  FIRST_RUN_PROMISE,
  FIRST_RUN_SETUP_LEAD,
  FIRST_RUN_STEPS,
  detectionLines,
  enterHint,
  homeCommandMatches,
  homeIntent,
  homeSentences,
  initialHomeState,
  slashQuery,
  type HomeKey,
  type HomeModel,
  type HomeState,
} from "./models/home-view";
import { THEME } from "./theme";

export interface InkHomeProps {
  readonly model: HomeModel;
  readonly onAnswer: (value: string, text?: string) => void;
  readonly onQuit: () => void;
}

interface InkKey {
  readonly upArrow: boolean;
  readonly downArrow: boolean;
  readonly return: boolean;
  readonly tab: boolean;
  readonly escape: boolean;
  readonly backspace: boolean;
  readonly delete: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
}

/** An Ink keypress as the shared home key. */
export function homeKeyFromInk(input: string, key: InkKey): HomeKey {
  const name = key.upArrow
    ? "up"
    : key.downArrow
      ? "down"
      : key.return
        ? "return"
        : key.tab
          ? "tab"
          : key.escape
            ? "escape"
            : key.backspace || key.delete
              ? "backspace"
              : input;
  return { name, sequence: input.length === 1 ? input : undefined, ctrl: key.ctrl, meta: key.meta };
}

/** The draft after a key the model left to the text field: a character, or a deletion. */
function editDraft(draft: string, input: string, key: InkKey): string {
  if (key.backspace || key.delete) {
    return [...draft].slice(0, -1).join("");
  }
  if (key.ctrl || key.meta || input.length === 0) {
    return draft;
  }
  return draft + input;
}

export function InkHome({ model, onAnswer, onQuit }: InkHomeProps): React.ReactElement {
  const [state, setState] = useState<HomeState>(() => initialHomeState(model));
  const sentences = homeSentences(model, state);
  const matches = homeCommandMatches(model, state.draft);

  useInput((input, key) => {
    const intent = homeIntent(model, state, homeKeyFromInk(input, key));
    if (intent.kind === "quit") {
      onQuit();
      return;
    }
    if (intent.kind === "answer") {
      onAnswer(intent.value, intent.text);
      return;
    }
    setState((current) => {
      const patched = { ...current, ...intent.patch };
      return intent.edit && model.firstRun === undefined
        ? { ...patched, draft: editDraft(patched.draft, input, key) }
        : patched;
    });
  });

  if (model.firstRun !== undefined) {
    return (
      <Box
        flexDirection="column"
        paddingX={2}
        paddingY={1}
      >
        <Text bold>jazz</Text>
        <Box
          marginTop={1}
          flexDirection="column"
        >
          <Text>{FIRST_RUN_PITCH}</Text>
          <Text color={THEME.secondary}>{FIRST_RUN_PROMISE}</Text>
          <Text color={THEME.muted}>
            {`${FIRST_RUN_SETUP_LEAD} ${FIRST_RUN_STEPS.map((step, index) => `${String(index + 1)} ${step}`).join(", ")}.`}
          </Text>
          {detectionLines(model).map((line) => (
            <Text
              key={line.label}
              color={THEME.success}
            >
              {`${line.lead} ${line.label} ${line.detail}.`}
            </Text>
          ))}
        </Box>
        <Box
          marginTop={1}
          flexDirection="column"
        >
          {model.firstRun.actions.map((action, index) => (
            <Text
              key={action.value}
              bold={index === state.commandIndex}
            >
              {`${index === state.commandIndex ? "›" : " "} ${action.label}`}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text color={THEME.muted}>↑↓ choose · enter select · esc quit</Text>
        </Box>
      </Box>
    );
  }

  const hint = enterHint(model, state);
  return (
    <Box
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <Text bold>jazz</Text>
      {sentences.start !== undefined && (
        <Box
          marginTop={1}
          flexDirection="column"
        >
          <Text>
            <Text
              bold
              color={THEME.primary}
            >
              {state.waitingValue === undefined ? "› " : "  "}
            </Text>
            <Text bold={state.waitingValue === undefined}>{sentences.start}</Text>
          </Text>
          <Text>
            <Text color={THEME.secondary}>{`${COMPOSER_PLACEHOLDER}: `}</Text>
            <Text>{state.draft}</Text>
            <Text color={THEME.primary}>▍</Text>
            {hint !== undefined ? <Text color={THEME.muted}>{`  ${hint}`}</Text> : null}
          </Text>
          {matches !== undefined &&
            (matches.length === 0 ? (
              <Text color={THEME.muted}>{`No home command starts with ${state.draft}`}</Text>
            ) : (
              matches.map((command, index) => (
                <CommandSuggestionItem
                  key={command.name}
                  command={command}
                  isSelected={index === Math.min(state.commandIndex, matches.length - 1)}
                  query={slashQuery(state.draft)}
                />
              ))
            ))}
        </Box>
      )}
      <Box
        marginTop={1}
        flexDirection="column"
      >
        <Text
          bold
          color={THEME.secondary}
        >
          {sentences.agentsHeading}
        </Text>
        {sentences.agents.map((agent) => (
          <Text
            key={agent.id}
            bold={agent.selected}
            color={agent.selected ? THEME.selected : THEME.secondary}
          >
            {`${agent.selected ? "›" : " "} ${agent.text}`}
          </Text>
        ))}
      </Box>
      {sentences.waitingHeading !== undefined && (
        <Box
          marginTop={1}
          flexDirection="column"
        >
          <Text
            bold
            color={THEME.secondary}
          >
            {sentences.waitingHeading}
          </Text>
          {sentences.waiting.map((entry) => (
            <Text
              key={entry.value}
              bold={entry.selected}
              color={entry.selected ? THEME.selected : THEME.secondary}
            >
              {`${entry.selected ? "›" : " "} ${entry.text}`}
            </Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={THEME.muted}>{sentences.footer}</Text>
      </Box>
    </Box>
  );
}
