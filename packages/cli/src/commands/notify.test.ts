import { describe, expect, it } from "bun:test";
import { type AddNotifyTargetOptions, targetFromOptions } from "./notify";

function options(overrides: Partial<AddNotifyTargetOptions>): AddNotifyTargetOptions {
  return { name: "phone", kind: "telegram", chatId: "42", ...overrides };
}

describe("targetFromOptions", () => {
  it("builds a target from its flags, with the events it takes", () => {
    expect(
      targetFromOptions(options({ events: "waiting, reminder", approveFromChat: true })),
    ).toEqual({
      name: "phone",
      kind: "telegram",
      chatId: "42",
      events: ["waiting", "reminder"],
      approveFromChat: true,
    });
    expect(targetFromOptions(options({ name: "desk", kind: "desktop" }))).toEqual({
      name: "desk",
      kind: "desktop",
    });
    expect(targetFromOptions(options({ name: "team", kind: "discord", channelId: "9" }))).toEqual({
      name: "team",
      kind: "discord",
      channelId: "9",
    });
  });

  it("refuses a name that cannot be a storage key", () => {
    expect(targetFromOptions(options({ name: "My Phone" }))).toContain("lowercase letters");
  });

  it("refuses an unknown kind and an unknown event", () => {
    expect(targetFromOptions(options({ kind: "pager" }))).toContain('Unknown target kind "pager"');
    expect(targetFromOptions(options({ events: "waiting,approval-needed" }))).toContain(
      "Unknown event approval-needed",
    );
  });

  it("refuses a target missing the flag its kind needs", () => {
    expect(targetFromOptions(options({ kind: "ntfy" }))).toBe("A ntfy target needs --url.");
    expect(targetFromOptions(options({ kind: "webhook" }))).toBe("A webhook target needs --url.");
    expect(targetFromOptions({ name: "phone", kind: "telegram" })).toContain("--chat-id");
  });
});
