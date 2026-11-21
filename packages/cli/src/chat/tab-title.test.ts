import { describe, expect, it } from "bun:test";
import { chatTabTitle } from "./tab-title";

describe("chatTabTitle", () => {
  it("shows the conversation's title once it has one", () => {
    expect(chatTabTitle("oss", "Landlord deposit dispute")).toBe("🎷 Landlord deposit dispute");
  });

  it("shows the agent while the conversation is untitled", () => {
    expect(chatTabTitle("oss", undefined)).toBe("🎷 Jazz - oss");
    expect(chatTabTitle("oss", "   ")).toBe("🎷 Jazz - oss");
  });
});
