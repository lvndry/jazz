import { Box, Text, useStdout } from "ink";
import React from "react";
import { THEME } from "./theme";

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
      <Box
        marginTop={1}
        flexDirection="column"
        paddingLeft={1}
      >
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

  // Calculate available width for content after accounting for indent
  // Ensure we have at least 1 character of content space to prevent infinite loops
  const contentWidth = width - indent.length;

  // If indent is too large relative to width, we can't wrap properly
  // Return as-is to avoid infinite loop (user will need wider terminal)
  if (contentWidth <= 0) {
    return [line];
  }

  const chunks: string[] = [];
  let rest = line;
  let isFirstChunk = true;
  let previousRestLength = rest.length;

  // First chunk keeps original indentation; subsequent chunks keep the same indentation.
  while (true) {
    // Check if we need to wrap
    const needsWrap = isFirstChunk ? rest.length > width : indent.length + rest.length > width;

    if (!needsWrap) {
      break;
    }

    if (isFirstChunk) {
      // First chunk: take full width (includes original indent)
      chunks.push(rest.slice(0, width));
      rest = rest.slice(width);
      isFirstChunk = false;
    } else {
      // Subsequent chunks: prepend indent, then take content that fits within width
      const takeChars = Math.max(1, Math.min(contentWidth, rest.length));
      chunks.push(indent + rest.slice(0, takeChars));
      rest = rest.slice(takeChars);

      // Safety check: if we're not making progress, break to prevent infinite loop
      if (rest.length >= previousRestLength) {
        // Force add remaining content and break
        if (rest.length > 0) {
          chunks.push(indent + rest);
        }
        return chunks;
      }
      previousRestLength = rest.length;
    }
  }

  // Add remaining content with proper indentation
  if (rest.length > 0) {
    if (isFirstChunk) {
      chunks.push(rest);
    } else {
      chunks.push(indent + rest);
    }
  }

  return chunks;
}
