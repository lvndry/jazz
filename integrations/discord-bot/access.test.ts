import { describe, expect, it } from "bun:test";
import {
  isSenderAllowed,
  messageMentionsUser,
  parseCommand,
  parseSnowflakeList,
  shouldRespond,
  stripBotMention,
  type AccessConfig,
  type MessageAccessContext,
} from "./access";

const USER = "123456789012345678";
const OTHER = "223456789012345678";
const CHANNEL = "323456789012345678";
const THREAD = "423456789012345678";
const GUILD = "523456789012345678";
const OTHER_GUILD = "623456789012345678";
const BOT = "723456789012345678";

function usersOnly(): AccessConfig {
  return {
    allowedUserIds: new Set([USER]),
    allowedChannelIds: new Set(),
    allowedGuildIds: new Set(),
    requireMention: true,
  };
}

function channelOnly(): AccessConfig {
  return {
    allowedUserIds: new Set(),
    allowedChannelIds: new Set([CHANNEL]),
    allowedGuildIds: new Set(),
    requireMention: true,
  };
}

function guildDm(overrides: Partial<MessageAccessContext> = {}): MessageAccessContext {
  return {
    isDm: true,
    isThread: false,
    userId: USER,
    channelId: CHANNEL,
    parentChannelId: undefined,
    guildId: undefined,
    mentionedBot: false,
    replyToBot: false,
    threadHasSession: false,
    ...overrides,
  };
}

function guildMsg(overrides: Partial<MessageAccessContext> = {}): MessageAccessContext {
  return {
    isDm: false,
    isThread: false,
    userId: USER,
    channelId: CHANNEL,
    parentChannelId: undefined,
    guildId: GUILD,
    mentionedBot: true,
    replyToBot: false,
    threadHasSession: false,
    ...overrides,
  };
}

describe("parseSnowflakeList", () => {
  it("keeps valid snowflakes and drops junk", () => {
    const ids = parseSnowflakeList(` ${USER}, not-an-id, ${CHANNEL}, `);
    expect([...ids].sort()).toEqual([CHANNEL, USER].sort());
  });

  it("treats empty input as an empty set", () => {
    expect(parseSnowflakeList("").size).toBe(0);
    expect(parseSnowflakeList("   ,  ").size).toBe(0);
  });
});

describe("isSenderAllowed", () => {
  it("allows DMs only from listed users", () => {
    expect(isSenderAllowed(usersOnly(), guildDm())).toBe(true);
    expect(isSenderAllowed(usersOnly(), guildDm({ userId: OTHER }))).toBe(false);
  });

  it("rejects DMs when only a channel allowlist is set", () => {
    expect(isSenderAllowed(channelOnly(), guildDm())).toBe(false);
  });

  it("lets a listed user talk in any guild channel", () => {
    expect(isSenderAllowed(usersOnly(), guildMsg({ mentionedBot: false }))).toBe(true);
  });

  it("lets anyone in an allowlisted channel through (user list empty)", () => {
    expect(isSenderAllowed(channelOnly(), guildMsg({ userId: OTHER }))).toBe(true);
  });

  it("rejects guild messages outside the channel allowlist", () => {
    expect(
      isSenderAllowed(channelOnly(), guildMsg({ channelId: THREAD, parentChannelId: undefined })),
    ).toBe(false);
  });

  it("treats a thread of an allowlisted channel as allowed", () => {
    expect(
      isSenderAllowed(
        channelOnly(),
        guildMsg({ channelId: THREAD, parentChannelId: CHANNEL, isThread: true }),
      ),
    ).toBe(true);
  });

  it("intersects user + channel lists when both are set", () => {
    const both: AccessConfig = {
      allowedUserIds: new Set([USER]),
      allowedChannelIds: new Set([CHANNEL]),
      allowedGuildIds: new Set(),
      requireMention: true,
    };
    expect(isSenderAllowed(both, guildMsg())).toBe(true);
    expect(isSenderAllowed(both, guildMsg({ userId: OTHER }))).toBe(false);
    expect(isSenderAllowed(both, guildMsg({ channelId: THREAD }))).toBe(false);
  });

  it("rejects a guild that is not on the guild allowlist", () => {
    const guilds: AccessConfig = {
      allowedUserIds: new Set(),
      allowedChannelIds: new Set(),
      allowedGuildIds: new Set([GUILD]),
      requireMention: true,
    };
    expect(isSenderAllowed(guilds, guildMsg())).toBe(true);
    expect(isSenderAllowed(guilds, guildMsg({ guildId: OTHER_GUILD }))).toBe(false);
  });
});

describe("shouldRespond", () => {
  const gated = usersOnly();

  it("always responds in DMs once the sender is allowed", () => {
    expect(shouldRespond(gated, guildDm())).toBe(true);
  });

  it("requires a mention in a guild channel by default", () => {
    expect(shouldRespond(gated, guildMsg({ mentionedBot: false }))).toBe(false);
    expect(shouldRespond(gated, guildMsg({ mentionedBot: true }))).toBe(true);
  });

  it("treats a reply to the bot as a mention", () => {
    expect(shouldRespond(gated, guildMsg({ mentionedBot: false, replyToBot: true }))).toBe(true);
  });

  it("does not require a mention in a thread the bot already joined", () => {
    expect(
      shouldRespond(
        gated,
        guildMsg({
          isThread: true,
          mentionedBot: false,
          threadHasSession: true,
        }),
      ),
    ).toBe(true);
  });

  it("still requires a mention in a stranger's thread", () => {
    expect(
      shouldRespond(
        gated,
        guildMsg({
          isThread: true,
          mentionedBot: false,
          threadHasSession: false,
        }),
      ),
    ).toBe(false);
  });

  it("skips mention-gating when requireMention is off", () => {
    const open: AccessConfig = { ...gated, requireMention: false };
    expect(shouldRespond(open, guildMsg({ mentionedBot: false }))).toBe(true);
  });
});

describe("mentions", () => {
  it("detects <@id> and <@!id> mentions", () => {
    expect(messageMentionsUser(`hey <@${BOT}> ping`, BOT)).toBe(true);
    expect(messageMentionsUser(`hey <@!${BOT}> ping`, BOT)).toBe(true);
    expect(messageMentionsUser(`hey <@${USER}> ping`, BOT)).toBe(false);
  });

  it("strips the bot mention and leaves the rest", () => {
    expect(stripBotMention(`<@${BOT}>  what's the weather`, BOT)).toBe("what's the weather");
    expect(stripBotMention(`<@!${BOT}> status`, BOT)).toBe("status");
  });
});

describe("parseCommand", () => {
  it("parses a slash command with args", () => {
    expect(parseCommand("/remind 30m pizza")).toEqual({
      command: "remind",
      args: "30m pizza",
    });
  });

  it("strips a bot username suffix", () => {
    expect(parseCommand("/help@JazzBot")).toEqual({ command: "help", args: "" });
  });

  it("returns undefined for ordinary text", () => {
    expect(parseCommand("remind me later")).toBeUndefined();
  });
});
