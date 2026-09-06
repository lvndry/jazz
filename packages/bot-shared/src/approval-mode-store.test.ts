import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  APPROVAL_MODE_LABELS,
  approvalModeFor,
  approvalPolicyFor,
  describeApprovalMode,
  setApprovalMode,
} from "./approval-mode-store";

const MODE_FILE = "tg-mode.json";
const SCOPE = "123456789012345678";
const OTHER = "223456789012345678";

describe("approval mode store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-approval-mode-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("defaults to safe before any /mode", () => {
    expect(approvalModeFor(tmpDir, MODE_FILE, SCOPE)).toBe("safe");
  });

  it("persists yolo and switches back to safe", () => {
    setApprovalMode(tmpDir, MODE_FILE, SCOPE, "yolo");
    expect(approvalModeFor(tmpDir, MODE_FILE, SCOPE)).toBe("yolo");
    setApprovalMode(tmpDir, MODE_FILE, SCOPE, "safe");
    expect(approvalModeFor(tmpDir, MODE_FILE, SCOPE)).toBe("safe");
  });

  it("stores nothing for safe so the deployment default keeps applying", () => {
    setApprovalMode(tmpDir, MODE_FILE, SCOPE, "yolo");
    setApprovalMode(tmpDir, MODE_FILE, SCOPE, "safe");
    const stored = JSON.parse(fs.readFileSync(path.join(tmpDir, MODE_FILE), "utf8")) as Record<
      string,
      string
    >;
    expect(stored).toEqual({});
  });

  it("keeps other conversations isolated", () => {
    setApprovalMode(tmpDir, MODE_FILE, SCOPE, "yolo");
    expect(approvalModeFor(tmpDir, MODE_FILE, OTHER)).toBe("safe");
  });

  it("preserves a corrupt file instead of clobbering every conversation", () => {
    const storePath = path.join(tmpDir, MODE_FILE);
    fs.writeFileSync(storePath, "{not json");
    setApprovalMode(tmpDir, MODE_FILE, SCOPE, "yolo");
    expect(fs.existsSync(`${storePath}.corrupt`)).toBe(true);
    expect(approvalModeFor(tmpDir, MODE_FILE, SCOPE)).toBe("yolo");
  });

  describe("describeApprovalMode", () => {
    const html = {
      bold: (text: string) => `<b>${text}</b>`,
      code: (text: string) => `<code>${text}</code>`,
    };
    const markdown = {
      bold: (text: string) => `**${text}**`,
      code: (text: string) => `\`${text}\``,
    };

    it("names the deployment's configured tier in safe mode", () => {
      expect(describeApprovalMode("safe", "read-only", html)).toContain("<code>read-only</code>");
      expect(describeApprovalMode("safe", "low-risk", markdown)).toContain("`low-risk`");
    });

    it("says yolo never stops, without naming a tier", () => {
      const described = describeApprovalMode("yolo", "read-only", markdown);
      expect(described).toContain("**🎲 Yolo**");
      expect(described).not.toContain("read-only");
    });

    it("keeps the same wording across both bridges' markup", () => {
      const withoutHtml = (text: string) => text.replace(/<\/?(?:b|code)>/g, "");
      const withoutMarkdown = (text: string) => text.replace(/\*\*|`/g, "");
      for (const mode of ["safe", "yolo"] as const) {
        expect(withoutHtml(describeApprovalMode(mode, "low-risk", html))).toBe(
          withoutMarkdown(describeApprovalMode(mode, "low-risk", markdown)),
        );
      }
    });

    it("labels both modes", () => {
      expect(APPROVAL_MODE_LABELS.safe).toContain("Safe");
      expect(APPROVAL_MODE_LABELS.yolo).toContain("Yolo");
    });
  });

  describe("approvalPolicyFor", () => {
    it("passes the deployment's configured tier through in safe mode", () => {
      expect(approvalPolicyFor(tmpDir, MODE_FILE, SCOPE, "read-only")).toBe("read-only");
      expect(approvalPolicyFor(tmpDir, MODE_FILE, SCOPE, "low-risk")).toBe("low-risk");
    });

    it("pins yolo to high-risk regardless of the configured tier", () => {
      setApprovalMode(tmpDir, MODE_FILE, SCOPE, "yolo");
      expect(approvalPolicyFor(tmpDir, MODE_FILE, SCOPE, "read-only")).toBe("high-risk");
    });
  });
});
