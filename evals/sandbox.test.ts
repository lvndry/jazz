import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  createSandbox,
  modelNetworkPorts,
  osSandboxActive,
  removeSandbox,
  sandboxedArgv,
} from "./sandbox";
import { stubInvocations, writeStubState } from "./stubs/state";

function shell(environment: Readonly<Record<string, string>>, script: string) {
  const proc = Bun.spawnSync(["/bin/sh", "-c", script], {
    env: { ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("sample sandbox", () => {
  it("points HOME, JAZZ_HOME, TMPDIR at the sample and schedules in-process", () => {
    const sandbox = createSandbox("sandbox-test");
    try {
      expect(sandbox.environment["HOME"]).toBe(sandbox.home);
      expect(sandbox.environment["JAZZ_HOME"]).toBe(join(sandbox.home, ".jazz"));
      expect(sandbox.environment["TMPDIR"]?.startsWith(sandbox.root)).toBe(true);
      expect(sandbox.environment["JAZZ_SCHEDULER"]).toBe("in-process");
      expect(sandbox.environment["PATH"]).not.toContain("/opt/homebrew");
    } finally {
      removeSandbox(sandbox);
    }
  });

  it("runs stub commands from PATH, logs every call, and keeps the network off", () => {
    const sandbox = createSandbox("sandbox-test", ["himalaya"]);
    try {
      writeStubState(sandbox.stubRoot, "mail", {
        accounts: ["personal"],
        mailboxes: {
          INBOX: [
            {
              id: "1",
              from: { name: "Landlord", addr: "landlord@example.com" },
              to: "me@ourco.com",
              subject: "Rent",
              date: "2026-09-20T10:00:00Z",
              flags: [],
              body: "Rent is due.",
            },
          ],
        },
        outbox: [],
        nextId: 2,
      });

      const listed = shell(sandbox.environment, "himalaya envelope list -m INBOX --json");
      const network = shell(sandbox.environment, "curl -s https://example.com");

      expect(JSON.parse(listed.stdout)).toMatchObject({
        envelopes: [{ id: "1", subject: "Rent" }],
      });
      expect(network.exitCode).toBe(6);
      const calls = stubInvocations(sandbox.stubRoot);
      expect(calls.map((call) => call.command)).toEqual(["himalaya", "curl"]);
    } finally {
      removeSandbox(sandbox);
    }
  });

  /**
   * The regression: a sample ran `/bin/launchctl` by absolute path, which a closed PATH
   * cannot stop, and registered a real LaunchAgent in the user's session.
   */
  it.skipIf(!osSandboxActive())(
    "blocks forbidden binaries by absolute path and writes to the real home",
    () => {
      const sandbox = createSandbox("sandbox-test");
      try {
        const probe = join(homedir(), `.jazz-eval-sandbox-probe-${process.pid}`);
        const argv = sandboxedArgv(
          [
            "/bin/sh",
            "-c",
            `/bin/launchctl list >/dev/null 2>&1; echo launchctl=$?; touch "${probe}" 2>/dev/null; echo home=$?; touch "${sandbox.tmp}/ok" && echo tmp=0`,
          ],
          sandbox.environment,
        );
        const proc = Bun.spawnSync(argv, { env: { ...sandbox.environment }, stdout: "pipe" });
        const output = proc.stdout.toString();
        expect(output).toContain("launchctl=126");
        expect(output).toContain("home=1");
        expect(output).toContain("tmp=0");
      } finally {
        removeSandbox(sandbox);
      }
    },
  );
});

describe("the OS sandbox's network", () => {
  const probe = (port: number) =>
    `fetch("http://127.0.0.1:${String(port)}/").then(() => console.log("reached"), () => console.log("refused"))`;

  async function reach(sandboxPorts: readonly number[], target: number): Promise<string> {
    const sandbox = createSandbox("sandbox-network", [], sandboxPorts);
    try {
      const child = Bun.spawn(
        sandboxedArgv([process.execPath, "-e", probe(target)], sandbox.environment),
        { env: { ...process.env, ...sandbox.environment }, stdout: "pipe", stderr: "ignore" },
      );
      const output = await new Response(child.stdout).text();
      await child.exited;
      return output.trim();
    } finally {
      removeSandbox(sandbox);
    }
  }

  it.skipIf(!osSandboxActive())(
    "refuses outbound connections except to the model's own port",
    async () => {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
      const port = server.port ?? 0;
      try {
        expect(await reach([], port)).toBe("refused");
        expect(await reach([port], port)).toBe("reached");
      } finally {
        void server.stop(true);
      }
    },
  );

  it("allows a local model server's port, or 443 for a hosted provider", () => {
    expect(
      modelNetworkPorts(["vllm"], { vllm: { base_url: "http://100.85.157.126:8090/v1" } }),
    ).toEqual([8090]);
    expect(modelNetworkPorts(["ollama"], {})).toEqual([11434]);
    expect(modelNetworkPorts(["openai", "openrouter"], {})).toEqual([443]);
  });

  /** The regression: a server set by VLLM_BASE_URL was refused because only config was read. */
  it("opens the port of a model server set in the environment", () => {
    const previous = process.env["VLLM_BASE_URL"];
    process.env["VLLM_BASE_URL"] = "http://10.0.0.5:9123/v1";
    try {
      expect(modelNetworkPorts(["vllm"], {})).toEqual([9123]);
    } finally {
      if (previous === undefined) {
        delete process.env["VLLM_BASE_URL"];
      } else {
        process.env["VLLM_BASE_URL"] = previous;
      }
    }
  });
});
