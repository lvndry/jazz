/**
 * Operator-owned SSH transport for detached runs.
 *
 * Every SSH option and remote program is fixed here. Host aliases and remote
 * paths are validated by the config schema and again at this spawn boundary;
 * secrets travel only on stdin. No SSH agent or local port is forwarded.
 */
import { spawn } from "node:child_process";
import { Transform, type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ProviderName } from "@jazz/core/constants/models";
import type { HostProfile } from "@jazz/core/types/host";

const SSH_OPTIONS = [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ForwardAgent=no",
  "-o",
  "ClearAllForwardings=yes",
  "-o",
  "ConnectTimeout=10",
] as const;
const MAX_OUTPUT_BYTES = 32 * 1024;
const TIMEOUT_MS = 30_000;
const PROVIDER_ORIGINS: Partial<Record<ProviderName, string>> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  openrouter: "https://openrouter.ai",
  xai: "https://api.x.ai",
  cerebras: "https://api.cerebras.ai",
  deepseek: "https://api.deepseek.com",
  fireworks: "https://api.fireworks.ai",
  groq: "https://api.groq.com",
  mistral: "https://api.mistral.ai",
  orcarouter: "https://api.orcarouter.ai",
  togetherai: "https://api.together.xyz",
};

export interface RemoteHostProbe {
  readonly os: "Linux" | "Darwin";
  readonly arch: "x64" | "arm64";
  readonly libc: "glibc" | "musl" | "none";
  readonly availableBytes: number;
  readonly jazzVersion?: string;
  readonly daemonHealthy: boolean;
  readonly localJazzPresent: boolean;
}

/** Validates values again after configuration, before they reach a process. */
function checkedHost(host: HostProfile): HostProfile {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/.test(host.sshTarget)) {
    throw new Error("SSH target must be a configured host alias");
  }
  if (
    !/^\/(?:[a-zA-Z0-9._-]+\/?)+$/.test(host.workspacePath) ||
    host.workspacePath.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("Remote workspace must be a simple absolute path");
  }
  return host;
}

/** Spawn SSH without a shell on this machine. Remote commands are fixed strings. */
function ssh(
  host: HostProfile,
  remoteCommand: string,
  stdin?: string | Readable,
  timeoutMs = TIMEOUT_MS,
): Promise<string> {
  checkedHost(host);
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...SSH_OPTIONS, "--", host.sshTarget, remoteCommand], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    function append(current: string, data: Buffer): string {
      const next = current + data.toString("utf8");
      if (next.length > MAX_OUTPUT_BYTES) child.kill("SIGKILL");
      return next.slice(0, MAX_OUTPUT_BYTES);
    }
    child.stdout.on("data", (data: Buffer) => {
      stdout = append(stdout, data);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = append(stderr, data);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(`SSH operation failed (${code ?? "signal"}): ${stderr.trim() || "no details"}`),
        );
      } else {
        resolve(stdout.trim());
      }
    });
    child.stdin.on("error", () => undefined);
    if (typeof stdin === "string" || stdin === undefined) {
      child.stdin.end(stdin);
    } else {
      stdin.on("error", (error) => {
        child.kill("SIGKILL");
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      });
      stdin.pipe(child.stdin);
    }
  });
}

/**
 * Check the remote machine without changing it. The workspace must exist and
 * belong to the remote user before detach is offered.
 */
export async function probeRemoteHost(host: HostProfile): Promise<RemoteHostProbe> {
  checkedHost(host);
  const command =
    `test -d '${host.workspacePath}' && test -w '${host.workspacePath}' && ` +
    `test ! -L '${host.workspacePath}' && ` +
    `printf '%s\\n' "$(uname -s)" "$(uname -m)" && ` +
    `if test -f /etc/alpine-release || test -f /lib/ld-musl-x86_64.so.1 || test -f /lib/ld-musl-aarch64.so.1; then echo musl; else echo glibc; fi && ` +
    `df -Pk '${host.workspacePath}' | tail -n 1 | awk '{print $4}' && ` +
    `if command -v jazz >/dev/null 2>&1; then jazz --version; else echo absent; fi; ` +
    `if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 3 http://127.0.0.1:4747/health >/dev/null 2>&1; then echo healthy; else echo absent; fi; ` +
    `if test -x "$HOME/.local/bin/jazz"; then echo local; else echo absent; fi`;
  const lines = (await ssh(host, command)).split("\n");
  const [osRaw, archRaw, libcRaw, kilobytesRaw, versionRaw, daemonRaw, localRaw] = lines;
  if (osRaw !== "Linux" && osRaw !== "Darwin") throw new Error("Unsupported remote OS");
  const arch =
    archRaw === "x86_64" || archRaw === "amd64"
      ? "x64"
      : archRaw === "arm64" || archRaw === "aarch64"
        ? "arm64"
        : undefined;
  if (arch === undefined) throw new Error("Unsupported remote architecture");
  const kilobytes = Number(kilobytesRaw);
  if (!Number.isSafeInteger(kilobytes) || kilobytes < 0)
    throw new Error("Cannot determine remote free disk space");
  return {
    os: osRaw,
    arch,
    libc: osRaw === "Darwin" ? "none" : libcRaw === "musl" ? "musl" : "glibc",
    availableBytes: kilobytes * 1024,
    daemonHealthy: daemonRaw === "healthy",
    localJazzPresent: localRaw === "local",
    ...(versionRaw !== undefined && versionRaw !== "absent" ? { jazzVersion: versionRaw } : {}),
  };
}

/**
 * Test DNS, TCP and TLS from the remote host to a known provider origin.
 * An HTTP 401/403 is reachable; authentication is checked by the actual run.
 */
export async function probeRemoteProvider(
  host: HostProfile,
  provider: ProviderName,
): Promise<void> {
  const origin = PROVIDER_ORIGINS[provider];
  if (origin === undefined)
    throw new Error(`Remote provider preflight is unsupported for ${provider}`);
  await ssh(host, `curl -sS -o /dev/null --connect-timeout 5 --max-time 10 -I '${origin}'`);
}

/**
 * Install a pinned release for the remote platform. The remote verifies the
 * archive against that release's SHA256SUMS before replacing its binary.
 */
export async function ensureRemoteJazz(host: HostProfile, requiredVersion: string): Promise<void> {
  if (!/^v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(requiredVersion)) {
    throw new Error("Invalid Jazz release version");
  }
  const version = requiredVersion.startsWith("v") ? requiredVersion : `v${requiredVersion}`;
  const probe = await probeRemoteHost(host);
  if (probe.jazzVersion?.replace(/^v/, "") === version.slice(1) && probe.localJazzPresent) {
    if (!probe.daemonHealthy) await startRemoteDaemon(host);
    await verifyRemoteProtocol(host);
    return;
  }
  if (probe.daemonHealthy) {
    throw new Error(
      "Remote daemon is running another Jazz version; stop or upgrade it before detach",
    );
  }
  const asset = `jazz-${probe.os.toLowerCase()}-${probe.arch}${probe.libc === "musl" ? "-musl" : ""}`;
  const base = `https://github.com/lvndry/jazz/releases/download/${version}`;
  const script = `set -eu
command -v curl >/dev/null
command -v gzip >/dev/null
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
curl -fsSL --retry 3 -o "$tmp/archive.gz" '${base}/${asset}.gz'
curl -fsSL --retry 3 -o "$tmp/SHA256SUMS" '${base}/SHA256SUMS'
expected=$(awk '$2 == "${asset}.gz" || $2 == "*${asset}.gz" { print $1; exit }' "$tmp/SHA256SUMS")
test -n "$expected"
if command -v sha256sum >/dev/null; then actual=$(sha256sum "$tmp/archive.gz" | awk '{print $1}'); else actual=$(shasum -a 256 "$tmp/archive.gz" | awk '{print $1}'); fi
test "$expected" = "$actual"
gzip -dc "$tmp/archive.gz" > "$tmp/jazz"
chmod 755 "$tmp/jazz"
mkdir -p "$HOME/.local/bin"
mv "$tmp/jazz" "$HOME/.local/bin/jazz"
"$HOME/.local/bin/jazz" --version
`;
  const result = await ssh(host, "sh -s", script);
  if (result.replace(/^v/, "") !== version.slice(1)) {
    throw new Error("Remote Jazz version did not match the requested release");
  }
  if (!(await probeRemoteHost(host)).daemonHealthy) await startRemoteDaemon(host);
  await verifyRemoteProtocol(host);
}

/** A matching version string alone does not prove that this binary understands detach. */
async function verifyRemoteProtocol(host: HostProfile): Promise<void> {
  const reply = await ssh(host, '"$HOME/.local/bin/jazz" detach _protocol');
  if (reply !== "jazz-detach-1")
    throw new Error("Remote Jazz does not support the detach protocol");
}

/** Start Jazz's loopback background daemon, then demand a healthy endpoint. */
async function startRemoteDaemon(host: HostProfile): Promise<void> {
  await ssh(host, '"$HOME/.local/bin/jazz" daemon >/dev/null 2>&1');
  if (!(await probeRemoteHost(host)).daemonHealthy) {
    throw new Error("Remote Jazz daemon did not become healthy on loopback");
  }
}

/** Transfer one selected provider secret via stdin to Jazz's private store. */
export async function transferRemoteSecret(
  host: HostProfile,
  secretPath: string,
  value: string,
): Promise<void> {
  if (!/^(?:llm|web_search)\.[a-z0-9_-]+\.api_key$/.test(secretPath) || value.length === 0) {
    throw new Error("Only nonempty provider API keys may be transferred");
  }
  const receipt = await ssh(
    host,
    `"$HOME/.local/bin/jazz" hosts _import-secret '${secretPath}'`,
    value,
  );
  if (receipt !== "stored") throw new Error("Remote secret import did not confirm storage");
}

/** Invoke a fixed detached-run helper; all dynamic data travels as JSON on stdin. */
export function runRemoteHelper(
  host: HostProfile,
  action: "_receive" | "_start" | "_status" | "_approve" | "_reject" | "_pull",
  stdin?: string,
): Promise<string> {
  if (!["_receive", "_start", "_status", "_approve", "_reject", "_pull"].includes(action)) {
    throw new Error("Invalid remote helper action");
  }
  return ssh(host, `"$HOME/.local/bin/jazz" detach ${action}`, stdin);
}

/** Stream a potentially large bundle to a fixed remote helper with backpressure. */
export function runRemoteHelperStream(
  host: HostProfile,
  action: "_receive" | "_start" | "_status" | "_approve" | "_reject" | "_pull",
  source: Readable,
): Promise<string> {
  if (!["_receive", "_start", "_status", "_approve", "_reject", "_pull"].includes(action)) {
    throw new Error("Invalid remote helper action");
  }
  return ssh(host, `"$HOME/.local/bin/jazz" detach ${action}`, source, 10 * 60_000);
}

/** Stream a remote result bundle to a writable sink without buffering it in memory. */
export async function downloadRemoteHelper(
  host: HostProfile,
  action: "_pull",
  stdinJson: string,
  destination: Writable,
): Promise<void> {
  checkedHost(host);
  if (action !== "_pull" || stdinJson.length > 8192) throw new Error("Invalid remote pull request");
  const child = spawn(
    "ssh",
    [...SSH_OPTIONS, "--", host.sshTarget, '"$HOME/.local/bin/jazz" detach _pull'],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(0, MAX_OUTPUT_BYTES);
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10 * 60_000);
  child.stdin.on("error", () => undefined);
  child.stdin.end(stdinJson);
  let received = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      callback(
        received > 2 * 1024 * 1024 * 1024 ? new Error("Remote result bundle exceeds 2 GiB") : null,
        chunk,
      );
    },
  });
  const exit = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`Remote pull failed (${code ?? "signal"}): ${stderr.trim() || "no details"}`),
          ),
    );
  });
  try {
    await Promise.all([pipeline(child.stdout, limit, destination), exit]);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
