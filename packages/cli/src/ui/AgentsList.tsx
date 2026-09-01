import { agentModelString } from "@jazz/core/utils/provider-model";
import { Box, Text } from "ink";
import React from "react";
import { formatToolsLine, getTerminalWidth, padRight } from "@/cli/utils/string-utils";
import { getGlyphs } from "./glyphs";
import { PADDING, PADDING_BUDGET, THEME } from "./theme";

const G = getGlyphs();

interface AgentListItem {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly config: {
    readonly llmProvider: string;
    readonly llmModel: string;
    readonly reasoningEffort?: string | undefined;
    readonly persona?: string | undefined;
    readonly tools?: readonly string[] | undefined;
  };
}

function truncateEnd(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.slice(0, Math.max(1, maxWidth - 1)) + "…";
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Agent list table. Rendered into Static scrollback, so it is sized ONCE for
 * the terminal width at print time (already-printed scrollback cannot reflow
 * on resize — that's inherent to terminals, not a bug here). The width math
 * accounts for the App's horizontal padding so rows never overflow and wrap.
 *
 * Column priority under narrow widths: name and model stay readable, the
 * description column is dropped entirely rather than truncated into noise.
 */
export function AgentsList(props: {
  readonly agents: readonly AgentListItem[];
  readonly verbose: boolean;
}): React.ReactElement {
  // Chrome around this component: App paddingX + OutputEntryView content
  // indent (PADDING_BUDGET covers both) plus a safety column for cursors.
  const inner = Math.max(40, getTerminalWidth() - PADDING_BUDGET - PADDING.content - 1);

  const gap = 2;
  const idxW = 3;
  const reasoningW = 9;
  const personaW = Math.max(8, Math.min(12, Math.floor(inner * 0.1)));
  const nameW = Math.max(12, Math.min(22, Math.floor(inner * 0.22)));
  const modelW = Math.max(16, Math.min(38, Math.floor(inner * 0.32)));
  const fixed = idxW + gap + nameW + gap + modelW + gap + personaW + gap + reasoningW;
  const descW = inner - fixed - gap;
  const showDescription = descW >= 12;

  const sp = " ".repeat(gap);

  return (
    <Box
      flexDirection="column"
      width={inner}
    >
      {/* Header */}
      <Box
        justifyContent="space-between"
        marginBottom={1}
      >
        <Text>
          <Text
            bold
            color={THEME.primary}
          >
            {G.note} Agents
          </Text>
          <Text dimColor> ({props.agents.length})</Text>
        </Text>
        <Text dimColor>jazz chat &lt;id|name&gt; · jazz edit &lt;id|name&gt;</Text>
      </Box>

      {/* Column headings */}
      <Text
        color={THEME.secondary}
        bold
      >
        {padRight("#", idxW)}
        {sp}
        {padRight("name", nameW)}
        {sp}
        {padRight("model", modelW)}
        {sp}
        {padRight("persona", personaW)}
        {sp}
        {padRight("reasoning", reasoningW)}
        {showDescription ? sp + "description" : ""}
      </Text>
      <Text dimColor>{G.divider.repeat(inner)}</Text>

      {/* Rows */}
      <Box
        flexDirection="column"
        marginTop={1}
      >
        {props.agents.map((agent, index) => {
          const persona = agent.config.persona ?? "default";
          const reasoning = agent.config.reasoningEffort ?? "—";
          const description =
            agent.description && agent.description !== agent.name ? agent.description : "";

          return (
            <Box
              key={agent.id}
              flexDirection="column"
              marginBottom={1}
            >
              <Text>
                <Text color={THEME.muted}>{padRight(String(index + 1), idxW)}</Text>
                {sp}
                <Text
                  bold
                  color={THEME.selected}
                >
                  {padRight(truncateEnd(agent.name, nameW), nameW)}
                </Text>
                {sp}
                <Text color={THEME.agent}>
                  {padRight(truncateEnd(agentModelString(agent.config), modelW), modelW)}
                </Text>
                {sp}
                <Text color={THEME.secondary}>
                  {padRight(truncateEnd(persona, personaW), personaW)}
                </Text>
                {sp}
                <Text color={reasoning === "—" ? THEME.muted : THEME.primary}>
                  {padRight(reasoning, reasoningW)}
                </Text>
                {showDescription ? (
                  <Text dimColor>
                    {sp}
                    {truncateEnd(description, descW)}
                  </Text>
                ) : null}
              </Text>

              {/* Meta line */}
              <Box paddingLeft={idxW + gap}>
                <Text
                  dimColor
                  italic
                >
                  {agent.config.llmProvider} · {truncateEnd(agent.id, 24)} · created{" "}
                  {formatDate(agent.createdAt)}
                </Text>
              </Box>

              {props.verbose && (
                <Box paddingLeft={idxW + gap}>
                  <Text dimColor>{formatToolsLine(agent.config.tools, inner - (idxW + gap))}</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
