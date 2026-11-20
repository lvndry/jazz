/**
 * The terminal tab title of a chat: the conversation's title once it has one, so tabs tell
 * conversations apart, else the agent it is with.
 */
export function chatTabTitle(agentName: string, conversationTitle: string | undefined): string {
  const title = conversationTitle?.trim();
  if (title === undefined || title.length === 0) {
    return `🎷 Jazz - ${agentName}`;
  }
  return `🎷 ${title}`;
}
