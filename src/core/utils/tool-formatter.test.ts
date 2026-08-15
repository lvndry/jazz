import { describe, expect, test } from "bun:test";
import { formatToolResult } from "./tool-formatter";

function formatCommand(result: { stdout?: string; stderr?: string; exitCode?: number }): string {
  return formatToolResult("execute_command", JSON.stringify(result));
}

describe("formatToolResult execute_command", () => {
  test("stdout only renders the output without labels", () => {
    const formatted = formatCommand({ stdout: "hello", exitCode: 0 });
    expect(formatted).toBe("hello");
  });

  test("stderr-only output keeps the stderr label", () => {
    const formatted = formatCommand({ stderr: "command not found", exitCode: 0 });
    expect(formatted).toBe("stderr:\ncommand not found");
  });

  test("both streams are separated and stderr is labeled", () => {
    const formatted = formatCommand({ stdout: "partial", stderr: "warning", exitCode: 0 });
    expect(formatted).toBe("partial\n\nstderr:\nwarning");
  });

  test("nonzero exit with output appends the failure footer", () => {
    const formatted = formatCommand({ stderr: "boom", exitCode: 2 });
    expect(formatted).toBe("stderr:\nboom\n\nfailed (exit code 2)");
  });

  test("nonzero exit without output reports failure and exit code", () => {
    const formatted = formatCommand({ exitCode: 127 });
    expect(formatted).toBe("failed (exit code 127), no output");
  });

  test("zero exit without output reports no output", () => {
    const formatted = formatCommand({ exitCode: 0 });
    expect(formatted).toBe("no output");
  });
});
