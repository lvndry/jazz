/**
 * Commander.js option parsers shared across CLI command definitions.
 */

/**
 * Build a Commander option parser that accepts only positive integers.
 *
 * Commander passes option values as raw strings; this validates and coerces
 * them, throwing a clear error (which Commander surfaces to the user) when the
 * value is not a positive integer.
 *
 * @param label - The flag name used in the error message (e.g. "--timeout").
 */
export function parsePositiveInt(label: string) {
  return (raw: string): number => {
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${label} must be a positive integer (got "${raw}").`);
    }
    return value;
  };
}
