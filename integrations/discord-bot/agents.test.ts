import { describe, expect, it } from "bun:test";
import { agentIdForChannel, channelIdFromAgentId } from "./agents";

describe("agent ids", () => {
  it("prefixes Discord snowflakes so they cannot collide with Telegram agents", () => {
    expect(agentIdForChannel("123456789012345678")).toBe("dc_123456789012345678");
  });

  it("round-trips a valid agent id", () => {
    const channelId = "123456789012345678";
    expect(channelIdFromAgentId(agentIdForChannel(channelId))).toBe(channelId);
  });

  it("rejects Telegram and junk agent ids", () => {
    expect(channelIdFromAgentId("tg_123")).toBeNull();
    expect(channelIdFromAgentId("dc_not-a-snowflake")).toBeNull();
    expect(channelIdFromAgentId("dc_")).toBeNull();
  });
});
