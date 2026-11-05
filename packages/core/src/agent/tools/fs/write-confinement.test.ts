import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createEditFileTools } from "./edit";
import { createReadFileTool } from "./read";
import { runTool } from "./test-helpers";
import { createWriteFileTools } from "./write";

/** `outside` sits beside the package, not under a temp root the policy allows. */
let workspace: string;
let outside: string;

beforeAll(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "jazz-fs-confinement-")));
  outside = mkdtempSync(join(process.cwd(), ".fs-confinement-outside-"));
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const write = createWriteFileTools();
const edit = createEditFileTools();
const read = createReadFileTool();
const confined = { shellConfinement: "on" as const };

describe("write_file under write confinement", () => {
  it("refuses a path outside the roots on both halves, before creating anything", async () => {
    const target = join(outside, "nested", "new.txt");
    const input = { path: target, content: "x\n" };
    const proposal = await runTool(write.approval, input, workspace, {
      ...confined,
      toolCallId: "c1",
    });
    expect(proposal.success).toBe(false);
    expect(proposal.error).toContain("Write confinement is on");
    expect(proposal.result).toBeNull();

    const execution = await runTool(write.execute, input, workspace, {
      ...confined,
      toolCallId: "c1",
    });
    expect(execution.success).toBe(false);
    expect(execution.error).toContain(target);
    expect(existsSync(join(outside, "nested"))).toBe(false);
  });

  it("refuses a write through a symlink that leaves the workspace", async () => {
    symlinkSync(outside, join(workspace, "escape"));
    const execution = await runTool(
      write.execute,
      { path: join(workspace, "escape", "via-link.txt"), content: "x\n" },
      workspace,
      { ...confined, toolCallId: "c2" },
    );
    expect(execution.success).toBe(false);
    expect(existsSync(join(outside, "via-link.txt"))).toBe(false);
  });

  it("still creates and overwrites inside the workspace", async () => {
    const path = join(workspace, "inside.txt");
    const input = { path, content: "one\n" };
    await runTool(write.approval, input, workspace, { ...confined, toolCallId: "c3" });
    expect(
      (await runTool(write.execute, input, workspace, { ...confined, toolCallId: "c3" })).success,
    ).toBe(true);

    const again = { path, content: "two\n" };
    await runTool(write.approval, again, workspace, { ...confined, toolCallId: "c4" });
    expect(
      (await runTool(write.execute, again, workspace, { ...confined, toolCallId: "c4" })).success,
    ).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("two\n");
  });

  it("is unchanged when confinement is off", async () => {
    const path = join(outside, "free.txt");
    const input = { path, content: "free\n" };
    await runTool(write.approval, input, workspace, { shellConfinement: "off", toolCallId: "c5" });
    const execution = await runTool(write.execute, input, workspace, {
      shellConfinement: "off",
      toolCallId: "c5",
    });
    expect(execution.success).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("free\n");
  });
});

describe("edit_file under write confinement", () => {
  const fakeSnapshot = `sha256:${"a".repeat(64)}`;

  function editArgs(path: string, snapshot: string) {
    return {
      path,
      snapshot,
      edits: [{ type: "replace_lines", startLine: 1, endLine: 1, content: "changed" }],
    };
  }

  it("refuses a file outside the roots on both halves and leaves it untouched", async () => {
    const path = join(outside, "existing.txt");
    writeFileSync(path, "original\n");
    const proposal = await runTool(
      edit.approval,
      editArgs(path, fakeSnapshot),
      workspace,
      confined,
    );
    expect(proposal.success).toBe(false);
    expect(proposal.error).toContain("Write confinement is on");

    const execution = await runTool(
      edit.execute,
      editArgs(path, fakeSnapshot),
      workspace,
      confined,
    );
    expect(execution.success).toBe(false);
    expect(execution.error).toContain("Write confinement is on");
    expect(readFileSync(path, "utf8")).toBe("original\n");
  });

  it("refuses an edit through a symlink out of the workspace", async () => {
    const real = join(outside, "linked.txt");
    writeFileSync(real, "original\n");
    mkdirSync(join(workspace, "links"));
    symlinkSync(real, join(workspace, "links", "file.txt"));
    const execution = await runTool(
      edit.execute,
      editArgs(join(workspace, "links", "file.txt"), fakeSnapshot),
      workspace,
      confined,
    );
    expect(execution.error).toContain("Write confinement is on");
    expect(readFileSync(real, "utf8")).toBe("original\n");
  });

  it("edits inside the workspace as before", async () => {
    const path = join(workspace, "editable.txt");
    writeFileSync(path, "original\n");
    const snapshot = (
      (await runTool(read, { path }, workspace, confined)).result as { snapshot: string }
    ).snapshot;
    const input = editArgs(path, snapshot);
    await runTool(edit.approval, input, workspace, { ...confined, toolCallId: "e1" });
    const execution = await runTool(edit.execute, input, workspace, {
      ...confined,
      toolCallId: "e1",
    });
    expect(execution.success).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("changed\n");
  });
});
