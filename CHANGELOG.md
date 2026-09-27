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
- **Deployed chat bots follow release tags.** `auto-update.sh` moves a bot checkout to the
  newest `vX.Y.Z` tag instead of every commit on `main`.

| Before                                         | After                                                        |
| ---------------------------------------------- | ------------------------------------------------------------ |
| no `autoApprove` in `WORKFLOW.md` (full yolo)  | add `autoApprove: high-risk` (or `true`) to keep that        |
| `autoApprove: readonly` (typo, meant yolo)     | fix the spelling: `autoApprove: read-only`                   |
| `autoApprove: false` still auto-approved reads | use `autoApprove: read-only` to allow reads unattended       |
| bots auto-updated to every commit on `main`    | set `JAZZ_DEPLOY_BRANCH=main` in the cron entry to keep that |

### Added

- `bun run test:e2e`: `jazz run --json` against a scripted model server, covering a tool
  call, an approval park (exit 2) and `jazz runs approve`.
- Release binaries and `SHA256SUMS` carry signed build provenance
  (`gh attestation verify`).
- [Upgrading](docs/upgrading.md): the 0.x versioning policy and how to fix a rejected config
  after an update.

### Changed

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

- `jazz runs approve --json` printed the resumed run's progress to stdout ahead of its
  envelope; stdout now carries only the envelope.
