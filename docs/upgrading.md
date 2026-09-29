---
description: "How Jazz versions its releases while it is 0.x, where breaking changes are announced, and what to do when an update rejects your config or changes a default."
---

# Upgrading Jazz

How to update Jazz without surprises, and what a version number tells you before you do.

## Versioning policy

Jazz is pre-1.0. Its version is `0.MINOR.PATCH`:

| Release                        | What it may contain                                                                | Your action                                              |
| ------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Patch (`0.15.44` to `0.15.45`) | Fixes and additions. No renamed or removed config keys, flags or output fields.    | None. `jazz update` is safe to run unattended.           |
| Minor (`0.15.x` to `0.16.0`)   | Anything a patch may, plus breaking changes, each listed with its migration.       | Read the release's **Breaking** section before updating. |
| Major (`1.0.0`)                | The first release with a stable contract; after it, breaking changes wait for 2.0. |                                                          |

"Breaking" means a change that makes a working setup fail or behave less permissively: a
renamed or removed config key, flag or envelope field, or a default that now grants less. A
default that grants _more_ is never shipped silently in any release.

Read the [GitHub release notes](https://github.com/lvndry/jazz/releases) before updating.
Breaking changes should include the migration steps needed to keep your setup working.

## Updating

```bash
jazz update
```

`jazz update` replaces a binary install from the GitHub release, or goes back through npm,
bun, pnpm or yarn for a package install. Chat bots deployed from a checkout follow release
tags on their own; see [Keeping it updated](./guides/deploy-a-chat-agent.md#keeping-it-updated).

To stay on a version, install it explicitly and skip `jazz update`:

```bash
curl -fsSL https://github.com/lvndry/jazz/releases/latest/download/install.sh |
  JAZZ_VERSION=v0.15.44 bash
```

## When an update rejects your config

`~/.jazz/config.json` is validated strictly: a key Jazz does not know is reported as an
invalid configuration on every command instead of being silently ignored, so a key renamed in
a minor release shows up the first time you run Jazz after updating. To find and fix it:

```bash
jazz config validate
```

It names each rejected key, and suggests the closest known one (`autoApproveCommands: not a
setting, did you mean autoApprovedCommands?`). Look it up in the
[GitHub release notes](https://github.com/lvndry/jazz/releases), rename or remove it, and run
`jazz config validate` again until it exits 0.

## Going back

If a release breaks something the release notes did not warn about, reinstall the previous
version with `JAZZ_VERSION` as shown above and
[open an issue](https://github.com/lvndry/jazz/issues) with the error.
