/**
 * Dotted config paths as typed on the command line: `llm.openai.api_key`.
 *
 * A segment may be wrapped in double quotes to hold dots of its own, which keys naming a
 * model or a server often do: `llm.capabilityOverrides.nvidia."deepseek-ai/deepseek-v4.1-flash".supportsTools`.
 */

/**
 * Split a dotted path into its segments, or undefined when it is malformed: an empty segment,
 * an unterminated quote, or a closing quote not followed by a dot or the end.
 */
export function splitConfigPath(path: string): string[] | undefined {
  const segments: string[] = [];
  let index = 0;
  while (index <= path.length) {
    if (path[index] === '"') {
      const close = path.indexOf('"', index + 1);
      if (close === -1) {
        return undefined;
      }
      const segment = path.slice(index + 1, close);
      const after = path[close + 1];
      if (segment === "" || (after !== undefined && after !== ".")) {
        return undefined;
      }
      segments.push(segment);
      index = close + 2;
      continue;
    }
    const dot = path.indexOf(".", index);
    const end = dot === -1 ? path.length : dot;
    const segment = path.slice(index, end);
    if (segment === "" || segment.includes('"')) {
      return undefined;
    }
    segments.push(segment);
    index = end + 1;
  }
  return segments;
}

/** Join segments back into a path `splitConfigPath` reads the same way, quoting any with a dot. */
export function joinConfigPath(segments: readonly string[]): string {
  return segments.map((segment) => (segment.includes(".") ? `"${segment}"` : segment)).join(".");
}
