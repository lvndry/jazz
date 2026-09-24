/** Read the value following `name` in `process.argv`, or `fallback` when the flag or its value is absent. */
export function readOption(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  return process.argv[index + 1] ?? fallback;
}
