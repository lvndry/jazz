/**
 * The home screen for the Ink renderer: screen readers, terminals too small for fullscreen, and
 * `--no-tui`. It reads top to bottom as complete sentences from the shared home model, and the
 * keys mean what they mean on the fullscreen home, because both ask `homeIntent`.
 */

import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import {
  COMPOSER_PLACEHOLDER,
  FIRST_RUN_PITCH,
  FIRST_RUN_PROMISE,
  FIRST_RUN_SETUP_LEAD,
  FIRST_RUN_STEPS,
  detectionLines,
  homeIntent,
  homeSentences,
  targetAgent,
  type HomeKey,
  type HomeModel,
} from "./models/home-view";
import { THEME } from "./theme";

export interface InkHomeProps {
  readonly model: HomeModel;
  readonly onAnswer: (value: string, text?: string) => void;
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

export function InkHome({ model, onAnswer }: InkHomeProps): React.ReactElement {
  const [selectedId, setSelectedId] = useState<string | undefined>(
    model.targetAgentId ?? model.agents[0]?.id,
  );
  const [draft, setDraft] = useState(model.draft ?? "");
  const sentences = homeSentences(model, selectedId);
  const target = targetAgent(model, selectedId);

  useInput((input, key) => {
    const homeKey = homeKeyFromInk(input, key);
    const intent = homeIntent(model, selectedId, draft, homeKey);
    switch (intent.kind) {
      case "move":
        setSelectedId(intent.agentId);
        return;
      case "answer":
        onAnswer(intent.value, intent.text);
        return;
      case "clear":
        setDraft("");
        return;
      case "type":
        if (homeKey.name === "backspace") {
          setDraft((current) => [...current].slice(0, -1).join(""));
        } else if (!key.ctrl && !key.meta && input.length > 0 && model.firstRun === undefined) {
          setDraft((current) => current + input);
        }
        return;
    }
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
        <Box marginTop={1}>
          <Text color={THEME.muted}>
            {model.keys.map((entry) => `${entry.key} ${entry.label}`).join(" · ")}
          </Text>
        </Box>
      </Box>
    );
  }

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
              {"› "}
            </Text>
            <Text bold>{sentences.start}</Text>
            <Text color={THEME.muted}>{"  enter"}</Text>
          </Text>
          <Text>
            <Text color={THEME.secondary}>{`${COMPOSER_PLACEHOLDER}: `}</Text>
            <Text>{draft}</Text>
            <Text color={THEME.primary}>▍</Text>
            {draft.length > 0 && target !== undefined ? (
              <Text color={THEME.muted}>{`  enter sends to ${target.name}`}</Text>
            ) : null}
          </Text>
          <Text color={THEME.muted}>↑↓ choose agent · tab all agents</Text>
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
          {sentences.waiting.map((line) => (
            <Text
              key={line}
              color={THEME.secondary}
            >
              {`  ${line}`}
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
