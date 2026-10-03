/** Messages shared by the code that starts a session and the code that runs one. */

/**
 * The consent ask made the first time a run reaches an app with no active grant. It always
 * asks, even under an auto-approve policy; approving it authorizes the app for the rest of
 * the run in memory.
 */
export function firstReachMessage(appName: string, bundleId: string): string {
  return (
    `Jazz wants to control ${appName} (${bundleId}) on your Mac for this run. ` +
    "Approving lets Jazz read and act in this app until the run ends. " +
    "Pre-authorize it next time with `jazz computer grant` in your own terminal."
  );
}

/** The tool result a person sees when declining a first reach. */
export function rejectionMessageFor(appName: string): string {
  return (
    `You declined access to ${appName}. The agent can retry later; ` +
    "pre-authorize the app with `jazz computer grant` if you want it to stop asking."
  );
}
