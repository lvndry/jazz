/**
 * Qualifies the program-status output through a real PTY: the fixture runs the
 * production emitters and the raw bytes must show exactly one deduplicated
 * working report, a blocked report with a base64 message, the terminal
 * notification, and a cwd report. No mocks — this is what a terminal receives.
 */
import { expect, test } from "bun:test";

const fixture = new URL("./program-status.pty-fixture.ts", import.meta.url).pathname;

test.skipIf(process.platform === "win32")("program status reaches a real PTY", async () => {
  let transport = "";
  const child = Bun.spawn(["bun", "run", fixture], {
    env: { ...process.env, TERM_PROGRAM: "ghostty" },
    terminal: {
      cols: 80,
      rows: 24,
      data: (_terminal, data) => {
        transport = (transport + Buffer.from(data).toString("utf8")).slice(-4000);
      },
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  child.terminal?.close();

  // Dedup: two identical working reports produce exactly one sequence.
  const working = transport.match(/state=working:app=jazz/g);
  expect(working?.length).toBe(1);

  // Blocked report carries the base64 message, and the terminal notification
  // (ghostty speaks OSC 777) follows it.
  const msg = Buffer.from("Delete the cache directory?", "utf8").toString("base64");
  expect(transport).toContain(`state=blocked:app=jazz:kind=permission:msg=${msg}\u001b\\`);
  expect(transport).toContain("\u001b]777;notify;Jazz: Delete the cache directory?;\u0007");

  // Done report and cwd report are present.
  expect(transport).toContain("state=done:app=jazz\u001b\\");
  expect(transport).toContain(`\u001b]7;${encodeURI(process.cwd())}\u001b\\`);
});
