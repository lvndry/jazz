/**
 * How a tool learns the user's time zone for one call: the zone the user named in their
 * message (passed as the tool's `timeZone`) wins over the conversation setting, the user's
 * configuration and the interactive host, and a surface that has none reports unknown.
 */

import type { ToolExecutionContext } from "@/core/types/tools";
import {
  parseTimeZone,
  resolveUserZone,
  unknownZoneInstruction,
  type UserZone,
  type UserZoneSource,
} from "@/core/utils/user-time-zone";

export type ToolZoneOutcome =
  | { readonly kind: "known"; readonly zone: string; readonly source: UserZoneSource }
  | { readonly kind: "unknown"; readonly instruction: string }
  | { readonly kind: "invalid"; readonly error: string };

/** The tool parameter description for the zone a user names in their message. */
export const TIME_ZONE_PARAMETER_DESCRIPTION =
  "IANA time zone the user named in their message, such as Europe/Paris. Pass it when the user states their zone or a zone for this request; leave it out otherwise.";

/** The zone the context carries from its surface, before any zone named in a message. */
function contextZone(context: ToolExecutionContext, explicit?: string): UserZone {
  const surfaceSource = context.timezoneSource;
  return resolveUserZone({
    explicit,
    chatSetting: surfaceSource === "chat-setting" ? context.timezone : undefined,
    userConfig: surfaceSource !== "chat-setting" ? context.timezone : undefined,
    hostIsUserDevice: context.hostIsUserDevice === true,
  });
}

export function resolveToolZone(
  context: ToolExecutionContext,
  explicitName: string | undefined,
): ToolZoneOutcome {
  if (explicitName !== undefined) {
    const parsed = parseTimeZone(explicitName);
    if (!parsed.ok) {
      return { kind: "invalid", error: parsed.error };
    }
  }
  const resolved = contextZone(context, explicitName);
  if (resolved.kind === "known") {
    return resolved;
  }
  return { kind: "unknown", instruction: unknownZoneInstruction(context.zoneSettingCommand) };
}
