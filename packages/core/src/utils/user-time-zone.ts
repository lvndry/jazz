/**
 * Whose time zone a request is in, and where that answer came from.
 *
 * A zone is request-local: it comes from a tool argument, a setting the user made, or the
 * machine they are sitting at. The zone of a server process says nothing about the user, so it
 * is never an answer on its own; a surface that cannot name the user's zone reports `unknown`
 * and the agent asks.
 */

/** Where a known zone came from, most specific first. */
export const USER_ZONE_SOURCES = [
  "tool-argument",
  "chat-setting",
  "user-config",
  "operator-default",
  "interactive-host",
] as const;

export type UserZoneSource = (typeof USER_ZONE_SOURCES)[number];

export type UserZone =
  | { readonly kind: "known"; readonly zone: string; readonly source: UserZoneSource }
  | { readonly kind: "unknown" };

export type ParsedTimeZone =
  { readonly ok: true; readonly zone: string } | { readonly ok: false; readonly error: string };

/** An IANA region name such as `Europe/Paris`, or `UTC`; offsets and abbreviations are not zones. */
const IANA_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

/**
 * The one place a zone name is validated: an IANA name the runtime knows, returned in its
 * canonical spelling (`europe/paris` becomes `Europe/Paris`).
 */
export function parseTimeZone(name: string): ParsedTimeZone {
  const trimmed = name.trim();
  if (
    trimmed.length === 0 ||
    !IANA_NAME_PATTERN.test(trimmed) ||
    (trimmed.toUpperCase() !== "UTC" && !trimmed.includes("/"))
  ) {
    return {
      ok: false,
      error: `"${name}" is not an IANA time zone name. Use a name such as Europe/Paris or America/New_York.`,
    };
  }
  try {
    const canonical = new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions()
      .timeZone;
    return { ok: true, zone: canonical };
  } catch {
    return {
      ok: false,
      error: `"${name}" is not an IANA time zone name this system knows. Use a name such as Europe/Paris or America/New_York.`,
    };
  }
}

export function isValidTimeZone(name: string): boolean {
  return parseTimeZone(name).ok;
}

/** The zone of the machine this process runs on. */
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export interface UserZoneInputs {
  /** A request-local zone supplied by a tool argument; not host-verified user provenance. */
  readonly explicit?: string | undefined;
  /** A zone stored for this conversation. */
  readonly chatSetting?: string | undefined;
  /** A zone the user configured for themselves, such as a `--timezone` flag. */
  readonly userConfig?: string | undefined;
  /** A bridge operator's explicit fallback for chats without their own setting. */
  readonly operatorDefault?: string | undefined;
  /** Whether this process runs on the user's own device, so the host zone is the user's. */
  readonly hostIsUserDevice: boolean;
  readonly hostZone?: string | undefined;
}

/**
 * The user's zone for one request: the first valid answer from the message, the conversation
 * setting, the user's configuration, then the host zone only when the host is the user's
 * device. A name that is not a valid IANA zone is skipped, never guessed at.
 */
export function resolveUserZone(inputs: UserZoneInputs): UserZone {
  const candidates: readonly (readonly [UserZoneSource, string | undefined])[] = [
    ["tool-argument", inputs.explicit],
    ["chat-setting", inputs.chatSetting],
    ["user-config", inputs.userConfig],
    ["operator-default", inputs.operatorDefault],
    ["interactive-host", inputs.hostIsUserDevice ? (inputs.hostZone ?? hostTimeZone()) : undefined],
  ];
  for (const [source, name] of candidates) {
    if (name === undefined) {
      continue;
    }
    const parsed = parseTimeZone(name);
    if (parsed.ok) {
      return { kind: "known", zone: parsed.zone, source };
    }
  }
  return { kind: "unknown" };
}

/**
 * What the model is told when the user's zone is not known: ask in the user's terms, then pass
 * the answer back. `settingCommand` is the surface's command that remembers a zone for the
 * conversation.
 */
export function unknownZoneInstruction(settingCommand?: string): string {
  const remember =
    settingCommand === undefined
      ? ""
      : ` Offer to remember it: the user can send ${settingCommand} once and it applies to every later request.`;
  return (
    "The user's time zone is not known on this surface. Ask where they are (their city or country), " +
    "never for a zone name or code, and never show them one to type. When ask_user_question is " +
    "available, offer the 2 to 4 most likely places as choices, judged from the conversation " +
    "(language, places and times mentioned), and let them name another. Convert their answer to " +
    'its IANA name yourself, confirm it in words ("Paris, so 14:00 your time"), then call this tool ' +
    "again with timeZone set to that name." +
    remember
  );
}
