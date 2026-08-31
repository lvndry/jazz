import { spawn } from "node:child_process";
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { Effect } from "effect";
import { KEYRING_SERVICE_NAME } from "./registry";

/**
 * Which secret store `keyringGet`/`keyringSet`/`keyringDelete` use.
 *
 * - `"macos"` — Keychain, via the `security` CLI.
 * - `"libsecret"` — the Linux Secret Service, via the `secret-tool` CLI (gnome-keyring or
 *   similar).
 * - `"file"` — a `chmod 600` JSON file under `$JAZZ_HOME`, used when neither OS keyring is
 *   reachable (typically a headless server with no D-Bus session).
 * - `"none"` — nothing stored; reads return nothing, writes are refused. Only reachable via
 *   the `$JAZZ_DISABLE_KEYRING` opt-out, since `"file"` covers every other case.
 *
 * `security`/`secret-tool` over a native keyring binding: jazz ships a slim install, and every
 * native binding drags prebuilt binaries per platform behind it. Both CLIs already ship with
 * their platform, so shelling out keeps the dependency footprint at zero.
 */
export type KeyringBackend = "macos" | "libsecret" | "file" | "none";

/** Human-readable name for a backend, for success/status messages. */
export function describeKeyringBackend(backend: KeyringBackend): string {
  switch (backend) {
    case "macos":
      return "the macOS keychain";
    case "libsecret":
      return "the Linux keyring";
    case "file":
      return "$JAZZ_HOME/secrets.json";
    case "none":
      return "nowhere";
  }
}

const PROBE_ACCOUNT = "__jazz_probe__";
const COMMAND_TIMEOUT_MS = 5_000;

interface CommandResult {
  readonly ok: boolean;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the binary itself is missing or the call never completed. */
  readonly unavailable: boolean;
}

function runCommand(
  command: string,
  args: readonly string[],
  stdin?: string,
): Effect.Effect<CommandResult, never> {
  return Effect.async<CommandResult, never>((resume) => {
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      resume(Effect.succeed(result));
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      finish({ ok: false, code: null, stdout: "", stderr: "", unavailable: true });
      return;
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, code: null, stdout: "", stderr: "", unavailable: true });
    }, COMMAND_TIMEOUT_MS);

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", () => {
      clearTimeout(timer);
      finish({ ok: false, code: null, stdout: "", stderr: "", unavailable: true });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      finish({
        ok: code === 0,
        code,
        stdout,
        stderr,
        unavailable: false,
      });
    });

    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    } else {
      child.stdin?.end();
    }

    return Effect.sync(() => {
      clearTimeout(timer);
      child.kill("SIGKILL");
    });
  });
}

function keyringDisabledByEnv(): boolean {
  const raw = process.env["JAZZ_DISABLE_KEYRING"];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/**
 * Determine which keyring backend is usable right now.
 *
 * On Linux this probes an actual lookup: `secret-tool` is frequently installed
 * on machines with no session D-Bus (headless servers), where every call fails.
 * Neither OS probe succeeding falls through to `"file"` rather than `"none"` — see the
 * `KeyringBackend` doc comment for why that fallback is safe to take automatically instead
 * of asking the operator to choose it.
 */
export function detectKeyringBackend(): Effect.Effect<KeyringBackend, never> {
  return Effect.gen(function* () {
    if (keyringDisabledByEnv()) return "none" as const;

    if (process.platform === "darwin") {
      const probe = yield* runCommand("security", [
        "find-generic-password",
        "-s",
        KEYRING_SERVICE_NAME,
        "-a",
        PROBE_ACCOUNT,
      ]);
      if (!probe.unavailable) return "macos" as const;
    } else if (process.platform === "linux") {
      const probe = yield* runCommand("secret-tool", [
        "lookup",
        "service",
        KEYRING_SERVICE_NAME,
        "account",
        PROBE_ACCOUNT,
      ]);
      // A clean "not found" exits non-zero with no diagnostics; a broken or
      // absent secret service always explains itself on stderr.
      if (!probe.unavailable && probe.stderr.trim() === "") return "libsecret" as const;
    }

    return "file" as const;
  });
}

const SECRETS_FILE_MODE = 0o600;

function secretsFilePath(): string {
  return path.join(getJazzHomeDirectory(), "secrets.json");
}

/** Missing file, unreadable file, or corrupt JSON all read as "nothing stored yet". */
function readSecretsFile(): Effect.Effect<Record<string, string>, never> {
  return Effect.promise(async () => {
    try {
      const raw = await nodeFs.readFile(secretsFilePath(), "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
      return {};
    } catch {
      return {};
    }
  });
}

/**
 * Write via a sibling temp file and rename, so a crash mid-write can't leave `secrets.json`
 * truncated or invalid. No cross-process lock: token writes are rare enough that a lost
 * update from two concurrent writers is an accepted risk, not worth the complexity.
 */
function writeSecretsFile(secrets: Record<string, string>): Effect.Effect<boolean, never> {
  return Effect.promise(async () => {
    const filePath = secretsFilePath();
    const tempPath = path.join(
      path.dirname(filePath),
      `.secrets-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );
    try {
      await nodeFs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await nodeFs.writeFile(tempPath, `${JSON.stringify(secrets, null, 2)}\n`, {
        mode: SECRETS_FILE_MODE,
      });
      await nodeFs.rename(tempPath, filePath);
      // `rename` preserves the temp file's mode, but chmod again in case `secrets.json`
      // already existed with a wider mode from before this fallback existed.
      await nodeFs.chmod(filePath, SECRETS_FILE_MODE);
      return true;
    } catch {
      await nodeFs.rm(tempPath, { force: true }).catch(() => undefined);
      return false;
    }
  });
}

/** Read a secret. Returns undefined when absent or unreadable. */
export function keyringGet(
  backend: KeyringBackend,
  account: string,
): Effect.Effect<string | undefined, never> {
  return Effect.gen(function* () {
    if (backend === "none") return undefined;
    if (backend === "file") {
      const secrets = yield* readSecretsFile();
      return secrets[account];
    }

    const result =
      backend === "macos"
        ? yield* runCommand("security", [
            "find-generic-password",
            "-w",
            "-s",
            KEYRING_SERVICE_NAME,
            "-a",
            account,
          ])
        : yield* runCommand("secret-tool", [
            "lookup",
            "service",
            KEYRING_SERVICE_NAME,
            "account",
            account,
          ]);

    if (!result.ok) return undefined;
    const value = result.stdout.replace(/\n$/, "");
    return value === "" ? undefined : value;
  });
}

/** Store a secret. Returns false when the keyring refused the write. */
export function keyringSet(
  backend: KeyringBackend,
  account: string,
  secret: string,
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    if (backend === "none") return false;
    if (backend === "file") {
      const secrets = yield* readSecretsFile();
      return yield* writeSecretsFile({ ...secrets, [account]: secret });
    }

    if (backend === "macos") {
      // `security` has no stdin mode for writes, so the value is briefly visible
      // in this process's argv. Accepted: macOS Keychain is a single-user
      // desktop path, and the multi-user exposure this guards against is Linux.
      const result = yield* runCommand("security", [
        "add-generic-password",
        "-U",
        "-s",
        KEYRING_SERVICE_NAME,
        "-a",
        account,
        "-w",
        secret,
      ]);
      return result.ok;
    }

    const result = yield* runCommand(
      "secret-tool",
      ["store", "--label", `jazz: ${account}`, "service", KEYRING_SERVICE_NAME, "account", account],
      secret,
    );
    return result.ok;
  });
}

/** Remove a secret. Missing entries are not an error. */
export function keyringDelete(
  backend: KeyringBackend,
  account: string,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (backend === "none") return;
    if (backend === "file") {
      const secrets = yield* readSecretsFile();
      if (!(account in secrets)) return;
      const { [account]: _removed, ...rest } = secrets;
      yield* writeSecretsFile(rest);
      return;
    }

    if (backend === "macos") {
      yield* runCommand("security", [
        "delete-generic-password",
        "-s",
        KEYRING_SERVICE_NAME,
        "-a",
        account,
      ]);
      return;
    }

    yield* runCommand("secret-tool", [
      "clear",
      "service",
      KEYRING_SERVICE_NAME,
      "account",
      account,
    ]);
  });
}
