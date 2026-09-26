/**
 * Operator commands for SSH hosts that may receive a detached conversation.
 *
 * Registration records only an SSH alias and a pre-existing remote workspace.
 * `doctor` checks the host key through OpenSSH before reporting capacity.
 * `_import-secret` is an internal stdin-only endpoint for the SSH transport.
 */
import { probeRemoteHost } from "@jazz/adapters/detach/remote-host";
import { detectKeyringBackend, keyringGet, keyringSet } from "@jazz/adapters/secrets/keyring";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import type { HostProfile } from "@jazz/core/types/host";
import { checkConfigWrite } from "@jazz/core/utils/config-schema";
import { Effect } from "effect";

function hostsFromConfig() {
  return Effect.gen(function* () {
    const config = yield* AgentConfigServiceTag;
    return (yield* config.appConfig).hosts ?? [];
  });
}

/** List operator-registered hosts without touching the network. */
export function listHostsCommand() {
  return Effect.gen(function* () {
    const hosts = yield* hostsFromConfig();
    if (hosts.length === 0) {
      process.stdout.write("No detach hosts registered.\n");
      return;
    }
    for (const host of hosts) {
      process.stdout.write(
        `${host.name}\t${host.sshTarget}\t${host.workspacePath}${
          host.allowFileSecrets === true ? "\tfile secrets allowed" : ""
        }\n`,
      );
    }
  });
}

/** Register one checked SSH alias and existing remote workspace. */
export function addHostCommand(
  name: string,
  sshTarget: string,
  workspacePath: string,
  options: { readonly allowFileSecrets: boolean } = { allowFileSecrets: false },
) {
  return Effect.gen(function* () {
    const candidate: HostProfile = {
      name,
      sshTarget,
      workspacePath,
      ...(options.allowFileSecrets ? { allowFileSecrets: true } : {}),
    };
    const checked = checkConfigWrite("hosts", [candidate]);
    if (!checked.ok) {
      throw new Error(`Invalid host registration: ${checked.problem}`);
    }
    const config = yield* AgentConfigServiceTag;
    const current = (yield* config.appConfig).hosts ?? [];
    if (current.some((host) => host.name === name)) {
      throw new Error(`Host ${name} already exists`);
    }
    const next = [...current, candidate];
    const revision = yield* config.revision;
    yield* config.set("hosts", next);
    if ((yield* config.revision) === revision) {
      throw new Error("Could not save host registration");
    }
    process.stdout.write(`Registered ${name}. Run jazz hosts doctor ${name} before detach.\n`);
  });
}

/** Remove a registered host; remote files and secrets stay on that host. */
export function removeHostCommand(name: string) {
  return Effect.gen(function* () {
    const config = yield* AgentConfigServiceTag;
    const current = (yield* config.appConfig).hosts ?? [];
    if (!current.some((host) => host.name === name)) {
      throw new Error(`No host named ${name}`);
    }
    const revision = yield* config.revision;
    yield* config.set(
      "hosts",
      current.filter((host) => host.name !== name),
    );
    if ((yield* config.revision) === revision) {
      throw new Error("Could not remove host registration");
    }
    process.stdout.write(`Removed ${name}.\n`);
  });
}

/** Verify SSH identity, remote directory, OS, architecture and free disk. */
export function doctorHostCommand(name: string) {
  return Effect.gen(function* () {
    const host = (yield* hostsFromConfig()).find((entry) => entry.name === name);
    if (host === undefined) {
      throw new Error(`No host named ${name}`);
    }
    const probe = yield* Effect.tryPromise(() => probeRemoteHost(host));
    process.stdout.write(
      `${host.name}: ${probe.os}/${probe.arch}${probe.libc === "musl" ? "/musl" : ""}, ` +
        `${Math.floor(probe.availableBytes / 1024 / 1024)} MiB free, ` +
        `Jazz ${probe.jazzVersion ?? "not installed"}, daemon ${probe.daemonHealthy ? "healthy" : "not reachable"}\n`,
    );
  });
}

/**
 * Internal remote endpoint. Consume one provider key from stdin, refusing an
 * absent/disabled store and checking read-back before claiming success.
 */
export function importRemoteSecretCommand(
  secretPath: string,
  options: { readonly allowFileStore: boolean } = { allowFileStore: false },
) {
  return Effect.gen(function* () {
    if (!/^(?:llm|web_search)\.[a-z0-9_-]+\.api_key$/.test(secretPath)) {
      throw new Error("Only provider API keys can be imported");
    }
    const backend = yield* detectKeyringBackend();
    if (backend === "none") {
      throw new Error("Remote secret storage is disabled");
    }
    if (backend === "file" && !options.allowFileStore) {
      throw new Error(
        "This host has no OS keyring. Install libsecret (secret-tool) with a running Secret " +
          "Service, or re-register the host with `jazz hosts add … --allow-file-secrets` to " +
          "keep the key in ~/.jazz/secrets.json (mode 600).",
      );
    }
    const value = yield* Effect.tryPromise(async () => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
        const data = Buffer.from(chunk);
        bytes += data.length;
        if (bytes > 16 * 1024) {
          throw new Error("Secret exceeds the import limit");
        }
        chunks.push(data);
      }
      return Buffer.concat(chunks).toString("utf8");
    });
    if (value.length === 0 || value.includes("\0")) {
      throw new Error("Invalid empty or binary secret");
    }
    const stored = yield* keyringSet(backend, secretPath, value);
    if (!stored) {
      throw new Error("Remote secret store refused the write");
    }
    if ((yield* keyringGet(backend, secretPath)) !== value) {
      throw new Error("Remote secret store did not verify the write");
    }
    process.stdout.write("stored\n");
  });
}
