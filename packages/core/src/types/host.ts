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
}
