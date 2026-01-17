import { Box, Text, useStdout } from "ink";
import React from "react";

/**
 * ConfigCard displays configuration with a minimal header design.
 * Uses spacing and subtle separators instead of box borders for copy-friendly terminal output.
 */
export function ConfigCard(props: {
  readonly title: string;
  readonly json: string;
  readonly note?: string | undefined;
}): React.ReactElement {
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
  const contentWidth = Math.max(20, inner - 2);

  const jsonLines = props.json.split("\n").flatMap((line) => wrapIndentedLine(line, contentWidth));

  return (
    <Box flexDirection="column" paddingX={1} width={width}>
      {/* Header */}
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          {props.title}
        </Text>
        <Text dimColor>jazz config get &lt;key&gt; · jazz config set &lt;key&gt;</Text>
      </Box>

      {/* Header separator */}
      <Box>
        <Text dimColor>{"─".repeat(Math.min(60, width - 2))}</Text>
      </Box>

      {props.note ? (
        <Box marginTop={1}>
          <Text dimColor>{props.note}</Text>
        </Box>
      ) : null}

      {/* JSON content - no borders for easy copying */}
      <Box marginTop={1} flexDirection="column" paddingLeft={1}>
        {jsonLines.map((line, idx) => (
          <Text key={idx}>{line}</Text>
        ))}
      </Box>

      {/* Bottom spacing */}
      <Box marginTop={1} />
    </Box>
  );
}

function wrapIndentedLine(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const indentMatch = line.match(/^(\s*)/);
  const indent = indentMatch?.[1] ?? "";
  const available = Math.max(8, width);

  const chunks: string[] = [];
  let rest = line;

  // First chunk keeps original indentation; subsequent chunks keep the same indentation.
  while (rest.length > available) {
    chunks.push(rest.slice(0, available));
    rest = indent + rest.slice(available);
  }
  chunks.push(rest);
  return chunks;
}

