/**
 * A machine explicitly registered by the operator for detached conversations.
 *
 * `sshTarget` is an SSH config alias, not a command or URL. The remote workspace
 * is an absolute directory dedicated to Jazz transfers. Validation at the
 * config boundary and again before process spawn keeps both values out of
 * arbitrary shell syntax.
 */
export interface HostProfile {
  readonly name: string;
  readonly sshTarget: string;
  readonly workspacePath: string;
  /**
   * Let a host without an OS keyring keep handed-off provider keys in its
   * `~/.jazz/secrets.json` (mode 600). Off by default, so a headless server without
   * libsecret fails the handoff instead of writing keys to disk unasked.
   */
  readonly allowFileSecrets?: boolean;
}
