/** The text a lesson entry holds: the rule first, since the first line is what recall shows. */
export function formatLessonEntry(rule: string, mistake: string): string {
  return `${rule}\n\nLearned from: ${mistake}\n`;
}
