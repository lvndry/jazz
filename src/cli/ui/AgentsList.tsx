import { Box, Text, useStdout } from "ink";
import React, { useRef } from "react";
import {
  formatIsoShort,
  formatProviderDisplayName,
  formatToolsLine,
  padRight,
  truncateMiddle,
} from "@/cli/utils/string-utils";
import { THEME } from "./theme";

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
    readonly agentType?: string | undefined;
    readonly tools?: readonly string[] | undefined;
  };
}

export function AgentsList(props: {
  readonly agents: readonly AgentListItem[];
  readonly verbose: boolean;
}): React.ReactElement {
  const { stdout } = useStdout();
  const [columns, setColumns] = React.useState<number>(() => stdout.columns ?? 80);
  const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    function handleResize(): void {
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
      resizeTimeoutRef.current = setTimeout(() => {
        setColumns(stdout.columns ?? 80);
      }, 100);
    }

    setColumns(stdout.columns ?? 80);
    stdout.on("resize", handleResize);
    return () => {
      stdout.off("resize", handleResize);
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
    };
  }, [stdout]);

  const width = Math.max(60, Math.min(columns, 140));
  const inner = Math.max(40, width - 4);

  // Column settings
  const idxW = 4;
  const nameW = Math.max(16, Math.min(24, Math.floor(inner * 0.2)));
  const modelW = Math.max(18, Math.min(28, Math.floor(inner * 0.22)));
  const typeW = Math.max(10, Math.min(12, Math.floor(inner * 0.1)));
  const reasoningW = 12;
  const gap = 2;
  const fixed = idxW + gap + nameW + gap + modelW + gap + typeW + gap + reasoningW + gap;
  const descW = Math.max(15, inner - fixed);

  const sp = " ".repeat(gap);

  return (
    <Box
      flexDirection="column"
      paddingX={2}
      width={width}
    >
      {/* Header Section */}
      <Box
        justifyContent="space-between"
        marginBottom={1}
      >
        <Text>
          <Text
            bold
            color={THEME.primary}
          >
            AGENTS
          </Text>
          <Text dimColor> ({props.agents.length})</Text>
        </Text>
        <Text dimColor>jazz chat &lt;id|name&gt; · jazz edit &lt;id|name&gt;</Text>
      </Box>

      {/* Table Header */}
      <Box
        borderStyle="single"
        borderBottom
        borderColor="gray"
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        paddingBottom={0}
      >
        <Text
          color="whiteBright"
          bold
        >
          {padRight("#", idxW)}
          {sp}
          {padRight("NAME", nameW)}
          {sp}
          {padRight("MODEL", modelW)}
          {sp}
          {padRight("TYPE", typeW)}
          {sp}
          {padRight("REASONING", reasoningW)}
          {sp}
          {padRight("DESCRIPTION", descW)}
        </Text>
      </Box>

      {/* Table Body */}
      <Box
        flexDirection="column"
        marginTop={1}
      >
        {props.agents.map((agent, i) => {
          const model = `${formatProviderDisplayName(agent.config.llmProvider)}/${agent.config.llmModel}`;
          const type = agent.config.agentType ?? "default";
          const reasoning = agent.config.reasoningEffort ?? "—";
          const desc = agent.description ?? "";

          return (
            <Box
              key={agent.id}
              flexDirection="column"
              marginBottom={1}
            >
              <Text>
                <Text color={THEME.primary}>{padRight(String(i + 1), idxW)}</Text>
                {sp}
                <Text
                  bold
                  color="white"
                >
                  {padRight(truncateMiddle(agent.name, nameW), nameW)}
                </Text>
                {sp}
                <Text color={THEME.primary}>{padRight(truncateMiddle(model, modelW), modelW)}</Text>
                {sp}
                <Text color="yellow">{padRight(truncateMiddle(type, typeW), typeW)}</Text>
                {sp}
                <Text color={reasoning === "—" ? "gray" : THEME.primary}>
                  {padRight(truncateMiddle(reasoning, reasoningW), reasoningW)}
                </Text>
                {sp}
                <Text dimColor>{truncateMiddle(desc, descW)}</Text>
              </Text>

              {/* Meta info below each row */}
              <Box paddingLeft={idxW + gap}>
                <Text
                  dimColor
                  italic
                >
                  {padRight(`ID: ${truncateMiddle(agent.id, 12)}`, 20)}
                  {" · "}
                  Created: {formatIsoShort(agent.createdAt)}
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

      {/* Bottom Footer */}
      <Box
        marginTop={1}
        borderStyle="single"
        borderTop
        borderColor="gray"
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        paddingTop={0}
      >
        <Text dimColor>Total active agents: {props.agents.length}</Text>
      </Box>
    </Box>
  );
}
