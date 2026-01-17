import { Box, Text, useStdout } from "ink";
import React from "react";

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

/**
 * AgentsList displays a list of agents with a minimal header design.
 * Uses spacing and subtle separators instead of box borders for copy-friendly terminal output.
 */
export function AgentsList(props: {
  readonly agents: readonly AgentListItem[];
  readonly verbose: boolean;
}): React.ReactElement {
  const { stdout } = useStdout();
  const [columns, setColumns] = React.useState<number>(() => stdout.columns ?? 80);

  React.useEffect(() => {
    function handleResize(): void {
      setColumns(stdout.columns ?? 80);
    }

    // Initial sync + subscribe
    handleResize();
    stdout.on("resize", handleResize);
    return () => {
      stdout.off("resize", handleResize);
    };
  }, [stdout]);

  const width = Math.max(60, Math.min(columns, 120));

  const inner = Math.max(40, width - 2);

  const idxW = 3;
  const nameW = Math.max(16, Math.min(28, Math.floor(inner * 0.28)));
  const modelW = Math.max(18, Math.min(30, Math.floor(inner * 0.25)));
  const typeW = Math.max(10, Math.min(14, Math.floor(inner * 0.12)));
  const updatedW = 16;
  const gap = 2;
  const fixed = idxW + gap + nameW + gap + modelW + gap + typeW + gap + updatedW + gap;
  const descW = Math.max(10, inner - fixed);

  return (
    <Box flexDirection="column" paddingX={1} width={width}>
      {/* Header */}
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          Agents ({props.agents.length})
        </Text>
        <Text dimColor>jazz agent get &lt;id|name&gt; · jazz agent chat &lt;id|name&gt;</Text>
      </Box>

      {/* Header separator */}
      <Box>
        <Text dimColor>{"─".repeat(Math.min(60, width - 2))}</Text>
      </Box>

      {/* Column headers */}
      <Box marginTop={1} flexDirection="row" paddingLeft={1}>
        <Text dimColor>
          {padRight("#", idxW)}
          {" ".repeat(gap)}
          {padRight("Name", nameW)}
          {" ".repeat(gap)}
          {padRight("Model", modelW)}
          {" ".repeat(gap)}
          {padRight("Type", typeW)}
          {" ".repeat(gap)}
          {padRight("Updated", updatedW)}
          {" ".repeat(gap)}
          {padRight("Description", descW)}
        </Text>
      </Box>

      {/* Agent rows */}
      <Box marginTop={1} flexDirection="column" paddingLeft={1}>
        {props.agents.map((agent, i) => {
          const model = `${formatProviderDisplayName(agent.config.llmProvider)}/${agent.config.llmModel}`;
          const type = agent.config.agentType ?? "default";
          const updated = formatIsoShort(agent.updatedAt);
          const desc = agent.description ?? "";

          return (
            <Box key={agent.id} flexDirection="column" marginBottom={i === props.agents.length - 1 ? 0 : 1}>
              <Text>
                {padRight(String(i + 1), idxW)}
                {" ".repeat(gap)}
                {padRight(truncateMiddle(agent.name, nameW), nameW)}
                {" ".repeat(gap)}
                {padRight(truncateMiddle(model, modelW), modelW)}
                {" ".repeat(gap)}
                {padRight(truncateMiddle(type, typeW), typeW)}
                {" ".repeat(gap)}
                {padRight(truncateMiddle(updated, updatedW), updatedW)}
                {" ".repeat(gap)}
                {padRight(truncateMiddle(desc, descW), descW)}
              </Text>

              <Text dimColor>
                id {truncateMiddle(agent.id, 28)}
                {"  ·  "}
                created {formatIsoShort(agent.createdAt)}
                {agent.config.reasoningEffort ? (
                  <>
                    {"  ·  "}
                    reasoning {String(agent.config.reasoningEffort)}
                  </>
                ) : null}
              </Text>

              {props.verbose ? (
                <Text dimColor>
                  {formatToolsLine(agent.config.tools, inner)}
                </Text>
              ) : null}
            </Box>
          );
        })}
      </Box>

      {/* Bottom spacing */}
      <Box marginTop={1} />
    </Box>
  );
}

function padRight(text: string, width: number): string {
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}

function truncateMiddle(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  if (max <= 10) return text.slice(0, max - 1) + "…";
  const keep = max - 1;
  const left = Math.ceil(keep * 0.6);
  const right = keep - left;
  return text.slice(0, left) + "…" + text.slice(text.length - right);
}

function formatIsoShort(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function formatProviderDisplayName(provider: string): string {
  if (provider === "ai_gateway") return "ai gateway";
  return provider;
}

function formatToolsLine(tools: readonly string[] | undefined, maxWidth: number): string {
  const list = tools ?? [];
  if (list.length === 0) return "tools none configured";
  const joined = list.join(", ");
  return truncateMiddle(`tools ${list.length} — ${joined}`, Math.max(20, maxWidth - 2));
}

