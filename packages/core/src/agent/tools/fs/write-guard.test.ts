import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { runTool } from "./test-helpers";
import { createWriteFileTools } from "./write";

const BOM = "﻿";

describe("write_file overwrite guard", () => {
  const directories: string[] = [];
  const write = createWriteFileTools();

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function fixture(content?: string) {
    const directory = mkdtempSync(join(tmpdir(), "jazz-write-guard-"));
    directories.push(directory);
    const path = join(directory, "sample.txt");
    if (content !== undefined) {
      writeFileSync(path, content);
    }
    return { directory, path };
  }

  it("refuses to overwrite a file that changed after the approval was shown", async () => {
    const { directory, path } = fixture("original\n");
    const input = { path, content: "rewritten\n" };
    const call = { toolCallId: "call-1" };
    expect((await runTool(write.approval, input, directory, call)).result).toMatchObject({
      approvalRequired: true,
    });
    writeFileSync(path, "another agent's work\n");

    const execution = await runTool(write.execute, input, directory, call);

    expect(execution.success).toBe(false);
    expect(execution.result).toMatchObject({ errorType: "StaleFileError" });
    expect(execution.error).toContain("Read the file again");
    expect(readFileSync(path, "utf8")).toBe("another agent's work\n");
  });

  it("refuses to create a file another writer created after the approval was shown", async () => {
    const { directory, path } = fixture();
    const input = { path, content: "mine\n" };
    const call = { toolCallId: "call-2" };
    await runTool(write.approval, input, directory, call);
    writeFileSync(path, "theirs\n");

    const execution = await runTool(write.execute, input, directory, call);

    expect(execution.result).toMatchObject({ errorType: "StaleFileError" });
    expect(readFileSync(path, "utf8")).toBe("theirs\n");
  });

  it("overwrites an unchanged file once approved, and the approval is spent", async () => {
    const { directory, path } = fixture("original\n");
    const input = { path, content: "rewritten\n" };
    const call = { toolCallId: "call-3" };
    await runTool(write.approval, input, directory, call);

    expect((await runTool(write.execute, input, directory, call)).success).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("rewritten\n");

    writeFileSync(path, "edited later\n");
    const spent = await runTool(write.execute, input, directory, call);
    expect(spent.result).toMatchObject({ errorType: "UnverifiedApprovalError" });
    expect(readFileSync(path, "utf8")).toBe("edited later\n");
  });

  it("keeps concurrent proposals for one path and content independent", async () => {
    const { directory, path } = fixture("v1\n");
    const input = { path, content: "mine\n" };
    await runTool(write.approval, input, directory, { toolCallId: "call-a" });
    writeFileSync(path, "v2\n");
    await runTool(write.approval, input, directory, { toolCallId: "call-b" });

    const first = await runTool(write.execute, input, directory, { toolCallId: "call-a" });
    expect(first.result).toMatchObject({ errorType: "StaleFileError" });
    expect(readFileSync(path, "utf8")).toBe("v2\n");
    const second = await runTool(write.execute, input, directory, { toolCallId: "call-b" });
    expect(second.success).toBe(true);
  });

  it("refuses a parked approval resumed after the file changed, though the proposal reran", async () => {
    const { directory, path } = fixture("v1\n");
    const input = { path, content: "mine\n" };
    const call = { toolCallId: "call-parked" };
    await runTool(write.approval, input, directory, call);
    writeFileSync(path, "changed while parked\n");
    await runTool(write.approval, input, directory, call);

    const execution = await runTool(write.execute, input, directory, call);

    expect(execution.result).toMatchObject({ errorType: "StaleFileError" });
    expect(readFileSync(path, "utf8")).toBe("changed while parked\n");
  });

  it("runs an approved overwrite of an unchanged file, proposal repeated or not", async () => {
    const { directory, path } = fixture("v1\n");
    const input = { path, content: "mine\n" };
    const call = { toolCallId: "call-normal" };
    await runTool(write.approval, input, directory, call);
    await runTool(write.approval, input, directory, call);

    expect((await runTool(write.execute, input, directory, call)).success).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("mine\n");
  });

  it("refuses an execution whose proposal this process never recorded", async () => {
    const { directory, path } = fixture("v1\n");
    const execution = await runTool(write.execute, { path, content: "mine\n" }, directory, {
      toolCallId: "never-proposed",
    });
    expect(execution.result).toMatchObject({ errorType: "UnverifiedApprovalError" });
    expect(execution.error).toContain("write_file");
    expect(readFileSync(path, "utf8")).toBe("v1\n");
  });

  it.skipIf(process.getuid?.() === 0)("refuses to treat an unreadable file as absent", async () => {
    const { directory, path } = fixture("secret-ish\n");
    chmodSync(path, 0o000);
    try {
      await expect(
        runTool(write.approval, { path, content: "x\n" }, directory, { toolCallId: "call-u" }),
      ).rejects.toThrow("cannot be read");
      await expect(runTool(write.execute, { path, content: "x\n" }, directory)).rejects.toThrow(
        "cannot be read",
      );
    } finally {
      chmodSync(path, 0o600);
    }
    expect(readFileSync(path, "utf8")).toBe("secret-ish\n");
  });

  it.skipIf(process.getuid?.() === 0)(
    "refuses when an unreadable file appeared after a new-file approval",
    async () => {
      const { directory, path } = fixture();
      const input = { path, content: "mine\n" };
      const call = { toolCallId: "call-appeared" };
      await runTool(write.approval, input, directory, call);
      writeFileSync(path, "theirs\n");
      chmodSync(path, 0o000);
      try {
        await expect(runTool(write.execute, input, directory, call)).rejects.toThrow(
          "cannot be read",
        );
      } finally {
        chmodSync(path, 0o600);
      }
      expect(readFileSync(path, "utf8")).toBe("theirs\n");
    },
  );

  it("creates a new file with the line endings it was given", async () => {
    const { directory, path } = fixture();
    await runTool(write.execute, { path, content: "a\r\nb" }, directory);
    expect(readFileSync(path, "utf8")).toBe("a\r\nb");
  });

  it("creates a new file without any prior approval or read", async () => {
    const { directory, path } = fixture();
    expect((await runTool(write.execute, { path, content: "new\n" }, directory)).success).toBe(
      true,
    );
    expect(readFileSync(path, "utf8")).toBe("new\n");
  });

  it("writes LF content with the CRLF endings and BOM of the file it replaces", async () => {
    const { directory, path } = fixture(`${BOM}a\r\nb\r\n`);
    const execution = await runTool(write.execute, { path, content: "x\ny\nz\n" }, directory);
    expect(execution.success).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(`${BOM}x\r\ny\r\nz\r\n`);
  });

  it("writes content that carries its own CRLF unchanged", async () => {
    const { directory, path } = fixture("a\nb\n");
    await runTool(write.execute, { path, content: "x\r\ny\r\n" }, directory);
    expect(readFileSync(path, "utf8")).toBe("x\r\ny\r\n");
  });
});
