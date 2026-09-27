import { shouldAutoApprove } from "@jazz/core/types/tools";
import { describe, expect, it } from "bun:test";
import { chatModeForPolicy, policyForChatMode, SAFE_MODE_POLICY } from "./approval-mode";

describe("chat approval modes", () => {
  it("runs safe mode at the low-risk tier, so only high-risk calls ask", () => {
    expect(policyForChatMode("safe")).toBe("low-risk");
    expect(shouldAutoApprove("read-only", SAFE_MODE_POLICY)).toBe(true);
    expect(shouldAutoApprove("low-risk", SAFE_MODE_POLICY)).toBe(true);
    expect(shouldAutoApprove("high-risk", SAFE_MODE_POLICY)).toBe(false);
    expect(shouldAutoApprove("unknown", SAFE_MODE_POLICY)).toBe(false);
  });

  it("runs yolo mode approving everything", () => {
    expect(shouldAutoApprove("high-risk", policyForChatMode("yolo"))).toBe(true);
  });

  it("reads a policy back as the mode it belongs to", () => {
    expect(chatModeForPolicy("low-risk")).toBe("safe");
    expect(chatModeForPolicy(undefined)).toBe("safe");
    expect(chatModeForPolicy(true)).toBe("yolo");
    expect(chatModeForPolicy("high-risk")).toBe("yolo");
  });
});
