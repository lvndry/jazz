# Changelog

Notable changes to Jazz, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). While Jazz is 0.x, breaking changes
ship only in a minor release (`0.15.x` to `0.16.0`) and are listed under **Breaking** with a
migration; see [Upgrading](docs/upgrading.md) for the full policy.

Releases before this file existed are described in their
[GitHub release notes](https://github.com/lvndry/jazz/releases).

## [Unreleased]

### Breaking

- **Workflow `autoApprove` defaults to `false`.** A `WORKFLOW.md` with no `autoApprove`
  field no longer runs fully auto-approved under `--auto-approve` or on a schedule. Its gated
  tools are declined on an unattended run.
- **Unknown `autoApprove` values are rejected.** A value other than `false`, `read-only`,
  `low-risk`, `high-risk` or `true` (for example `readonly` or `"false"`) makes the workflow
  fail to load instead of silently meaning `true`.
- **`autoApprove: false` is strict.** It approves nothing, including tools that
  `read-only` or `low-risk` would have let through.
- **macOS desktop notifications use only `terminal-notifier`.** The AppleScript fallback is
  gone. The release binary bundles `terminal-notifier`; a Jazz installed another way needs
  `brew install terminal-notifier` (or `JAZZ_TERMINAL_NOTIFIER`), and without it a desktop
  notification fails with that instruction instead of showing through AppleScript.
- **Webhook notify bodies are `{ id, type, title, body, event }`.** The event moved under
  `event` (with `kind`, not `type`, naming it), and a `paused` event carries `pause` and
  `reason` but no `spend`. See [Notifications](docs/configure/notifications.md#webhook-bodies-and-signatures).
- **Deployed chat bots follow release tags.** `auto-update.sh` moves a bot checkout to the
  newest `vX.Y.Z` tag instead of every commit on `main`.

| Before                                         | After                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| no `autoApprove` in `WORKFLOW.md` (full yolo)  | add `autoApprove: high-risk` (or `true`) to keep that                |
| `autoApprove: readonly` (typo, meant yolo)     | fix the spelling: `autoApprove: read-only`                           |
| `autoApprove: false` still auto-approved reads | use `autoApprove: read-only` to allow reads unattended               |
| bots auto-updated to every commit on `main`    | set `JAZZ_DEPLOY_BRANCH=main` in the cron entry to keep that         |
| macOS desktop notifications via AppleScript    | `brew install terminal-notifier`, or the release binary (bundles it) |
| webhook body `{ title, body, type, item }`     | read `event.item` (or `event.pause`, `event.reason`); no `spend`     |

### Added

- **`ask_user_secret`: secrets the person types stay out of the model.** The agent asks for a
  password, token or passphrase; it is typed hidden (bullets in both terminal interfaces, a
  private chat in the bridges) and the model gets `[redacted:<name>]`. The value is held in memory
  for the run, redacted from every tool result and log line, and put back only into `read_pdf`'s
  and `pdf_page_count`'s `password` and `execute_command`'s `command` (which then always asks).
  A parked run takes the secret with `jazz runs secret <run id>`. See
  [Secrets the person types](docs/security/secrets-and-egress.md#secrets-the-person-types).
- **Private network hosts.** A model-chosen URL on this machine or the local network asks for
  approval, and approving adds the address to the global `network.allowPrivateHosts`, so later
  requests go through unasked. Only the global config sets the list; edit it from `jazz` > Update
  configuration > Private Network Hosts.
- `bun run test:e2e`: `jazz run --json` against a scripted model server, covering a tool
  call, an approval park (exit 2) and `jazz runs approve`.
- Release binaries and `SHA256SUMS` carry signed build provenance
  (`gh attestation verify`).
- [Upgrading](docs/upgrading.md): the 0.x versioning policy and how to fix a rejected config
  after an update.
- **Notifications in your terminal.** In kitty, Ghostty, WezTerm, Warp and iTerm2, desktop
  notifications are sent to the terminal as an escape sequence (OSC 99, 777 or 9) instead of
  through `terminal-notifier` or `notify-send`, including inside tmux with
  `allow-passthrough on`. `notifications.terminal` (or `JAZZ_NOTIFICATIONS_TERMINAL`) forces a
  sequence, for example over SSH, or turns it `off`. The daemon, scheduled runs and the bridges
  keep using the system notifier. See
  [Desktop notifications](docs/configure/notifications.md#desktop-notifications).

### Changed

- **Sub-agents run beside the agent and can be steered.** `spawn_subagent` returns an `agentId`
  at once instead of the child's answer; the agent collects answers with `wait_subagents`, checks
  on children with `list_subagents`, and messages, pauses, resumes or cancels one with
  `steer_subagent`. An agent granted `spawn_subagent` gets the three new tools with it. At most
  four run at once, they never outlive the turn, and children running together now share the
  parent's `maxCostUSD`.
- **Secret files read like any other file; secret values are redacted instead.** `read_file`,
  `grep`, `find`, `ls`, `cp`, `mv` and the edit tools no longer treat `.env`, `secrets.json` or
  Jazz's config specially. Every tool result is redacted before it is logged or shown: secrets Jazz
  holds and credential-named environment variables exactly, `.env`-style assignments, key formats
  and private keys by shape. `write_file` and `edit_file` refuse text carrying a `[redacted:`
  placeholder. The `$JAZZ_HOME/.protected-files.json` registry is no longer read and can be deleted.
- A release is created as a draft and published only after every binary is attached and
  has run on its own platform, so `releases/latest/download/install.sh` never serves a
  release without its assets.

### Fixed

- `jazz run --park` reported a run parked on a question as waiting for an approval, with the
  approve command; it now names what the run waits for and the command that answers it.
- A `jazz daemon` started in the background runs in a session of its own, detached from the
  terminal that launched it, so it never writes terminal notifications there.
- `jazz runs approve --json` printed the resumed run's progress to stdout ahead of its
  envelope; stdout now carries only the envelope.
