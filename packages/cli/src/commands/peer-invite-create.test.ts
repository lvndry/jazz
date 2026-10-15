/**
 * Checks invitation persistence and user output with default remote-address discovery. The
 * public-IP request is stubbed, and every invite is written to a disposable Jazz home.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listInvites } from "@jazz/adapters/peers/invites";
import { createPersonaServiceLayer } from "@jazz/adapters/persona-service";
import { expect, it, spyOn } from "bun:test";
import { Effect } from "effect";
import { createInviteCommand } from "./peer-invites";

it.each([true, false])(
  "creates a remote invite or reports discovery failure without saving one (%s)",
  async (lookupWorks) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-default-invite-"));
    const previousHome = process.env["JAZZ_HOME"];
    const previousExitCode = process.exitCode;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const out = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const err = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    async function lookupAddress(
      url: Parameters<typeof fetch>[0],
      options?: Parameters<typeof fetch>[1],
    ): Promise<Response> {
      expect(String(url)).toBe("https://api.ipify.org");
      expect(options?.body).toBeUndefined();
      if (!lookupWorks) throw new Error("lookup unavailable");
      return new Response("203.0.113.42");
    }
    const lookup = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(lookupAddress, { preconnect: globalThis.fetch.preconnect }),
    );
    try {
      process.env["JAZZ_HOME"] = home;
      process.exitCode = 0;
      await Effect.runPromise(
        createInviteCommand({
          inviteeName: "alice",
          disclosure: "internal",
          ttlMs: 10_800_000,
          port: 4747,
          json: true,
          qr: false,
        }).pipe(Effect.provide(createPersonaServiceLayer())),
      );
      const records = await Effect.runPromise(listInvites());
      if (lookupWorks) {
        expect(process.exitCode).toBe(0);
        expect(records).toHaveLength(1);
        const record = records[0];
        expect(record?.inviterAskUrl).toBe("http://203.0.113.42:4747/peer/ask");
        expect(record?.proposedTier).toBe("internal");
        expect(Date.parse(record?.expiresAt ?? "") - Date.parse(record?.createdAt ?? "")).toBe(
          10_800_000,
        );
        const envelope: unknown = JSON.parse(stdout.join(""));
        expect(envelope).toMatchObject({
          ok: true,
          url: expect.stringMatching(/^http:\/\/203\.0\.113\.42:4747\/peer-invites\/.+#.+$/),
        });
      } else {
        expect(process.exitCode).toBe(1);
        expect(records).toHaveLength(0);
        expect(stdout).toEqual([]);
        expect(stderr.join("")).toContain("lookup unavailable");
        expect(stderr.join("")).toContain("--host");
      }
    } finally {
      lookup.mockRestore();
      out.mockRestore();
      err.mockRestore();
      if (previousHome === undefined) delete process.env["JAZZ_HOME"];
      else process.env["JAZZ_HOME"] = previousHome;
      process.exitCode = previousExitCode ?? 0;
      await fs.rm(home, { recursive: true, force: true });
    }
  },
);
