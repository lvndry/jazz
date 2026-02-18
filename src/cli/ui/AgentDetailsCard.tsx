import { Box, Text, useStdout } from "ink";
import React from "react";
import { formatProviderDisplayName } from "@/core/utils/string";
import { THEME } from "./theme";

interface AgentDetailsItem {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly model?: string | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly config: {
    readonly persona?: string | undefined;
    readonly llmProvider: string;
    readonly llmModel: string;
    readonly reasoningEffort?: string | undefined;
    readonly tools?: readonly string[] | undefined;
  };
}

/**
 * AgentDetailsCard displays agent information with a minimal header design.
 * Uses spacing and subtle separators instead of box borders for copy-friendly terminal output.
 */
export function AgentDetailsCard(props: { readonly agent: AgentDetailsItem }): React.ReactElement {
  const { stdout } = useStdout();
  const [columns, setColumns] = React.useState<number>(() => stdout.columns ?? 80);

  React.useEffect(() => {
    function handleResize(): void {
      setColumns(stdout.columns ?? 80);
    }
    handleResize();
    stdout.on("resize", handleResize);
    return () => {
      stdout.off("resize", handleResize);
    };
  }, [stdout]);

  const width = Math.max(60, Math.min(columns, 120));
  const inner = Math.max(40, width - 2);

  const agent = props.agent;
  const model = agent.model?.trim().length
    ? agent.model
    : `${agent.config.llmProvider}/${agent.config.llmModel}`;
  const tools = agent.config.tools ?? [];

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      width={width}
    >
      {/* Header */}
      <Box justifyContent="space-between">
        <Text
          bold
          color={THEME.primary}
        >
          Agent: {agent.name}
        </Text>
        <Text dimColor>jazz agent chat &lt;id|name&gt;</Text>
      </Box>

      {/* Header separator */}
      <Box>
        <Text dimColor>{"─".repeat(Math.min(60, width - 2))}</Text>
      </Box>

      {/* Basic info */}
      <Box
        marginTop={1}
        flexDirection="column"
        paddingLeft={1}
      >
        <KeyValue
          label="ID"
          value={agent.id}
          innerWidth={inner}
        />
        <KeyValue
          label="Model"
          value={model}
          innerWidth={inner}
        />
        <KeyValue
          label="Created"
          value={formatIsoShort(agent.createdAt)}
          innerWidth={inner}
        />
        <KeyValue
          label="Updated"
          value={formatIsoShort(agent.updatedAt)}
          innerWidth={inner}
        />
        <KeyValue
          label="Description"
          value={agent.description?.trim().length ? agent.description : "—"}
          innerWidth={inner}
          wrap
        />
      </Box>

      {/* Configuration section */}
      <Box
        marginTop={1}
        flexDirection="column"
      >
        <Text
          bold
          color="gray"
        >
          Configuration
        </Text>
        <Box
          flexDirection="column"
          paddingLeft={1}
        >
          <KeyValue
            label="Persona"
            value={agent.config.persona ?? "default"}
            innerWidth={inner - 2}
          />
          <KeyValue
            label="Provider"
            value={formatProviderDisplayName(agent.config.llmProvider)}
            innerWidth={inner - 2}
          />
          <KeyValue
            label="Model"
            value={agent.config.llmModel}
            innerWidth={inner - 2}
          />
          <KeyValue
            label="Reasoning"
            value={agent.config.reasoningEffort ? String(agent.config.reasoningEffort) : "—"}
            innerWidth={inner - 2}
          />
        </Box>
      </Box>

      {/* Tools section */}
      <Box
        marginTop={1}
        flexDirection="column"
      >
        <Box justifyContent="space-between">
          <Text
            bold
            color="gray"
          >
            Tools
          </Text>
          <Text dimColor>{tools.length}</Text>
        </Box>
        <Box paddingLeft={1}>
          {tools.length === 0 ? (
            <Text dimColor>none configured</Text>
          ) : (
            <Text>{formatToolsGrid(tools, Math.max(20, inner - 2))}</Text>
          )}
        </Box>
      </Box>

      {/* Bottom spacing */}
      <Box marginTop={1} />
    </Box>
  );
}

function KeyValue(props: {
  readonly label: string;
  readonly value: string;
  readonly innerWidth: number;
  readonly wrap?: boolean | undefined;
}): React.ReactElement {
  const labelW = 12;
  const gap = 2;
  const valueW = Math.max(10, props.innerWidth - labelW - gap);

  if (!props.wrap) {
    return (
      <Text>
        <Text dimColor>{padRight(props.label, labelW)}</Text>
        {" ".repeat(gap)}
        {truncateMiddle(props.value, valueW)}
      </Text>
    );
  }

  // Wrap value across multiple lines with indentation aligned to the value column.
  const lines = wrapText(props.value, valueW);
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>{padRight(props.label, labelW)}</Text>
        {" ".repeat(gap)}
        {lines[0] ?? ""}
      </Text>
      {lines.slice(1).map((line, idx) => (
        <Text key={idx}>
          <Text dimColor>{padRight("", labelW)}</Text>
          {" ".repeat(gap)}
          {line}
        </Text>
      ))}
    </Box>
  );
}

function formatToolsGrid(tools: readonly string[], availableWidth: number): string {
  // Render tools as a text grid (fewer Ink nodes, better performance).
  const maxLen = tools.reduce((m, t) => Math.max(m, t.length), 0);
  const colW = Math.max(12, Math.min(28, maxLen + 2));
  const cols = Math.max(1, Math.floor(availableWidth / colW));

  const rows = Math.ceil(tools.length / cols);
  const lines: string[] = [];

  for (let r = 0; r < rows; r++) {
    const parts: string[] = [];
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (idx >= tools.length) break;
      parts.push(padRight(truncateMiddle(tools[idx] ?? "", colW - 2), colW));
    }
    lines.push(parts.join(""));
  }

  return lines.join("\n");
}

function wrapText(text: string, width: number): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return [""];
  const words = cleaned.split(" ");

  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length === 0) {
      line = w;
      continue;
    }
    if (line.length + 1 + w.length <= width) {
      line = `${line} ${w}`;
    } else {
      lines.push(line);
      line = w;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.map((l) => truncateMiddle(l, width));
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
