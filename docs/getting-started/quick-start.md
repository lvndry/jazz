---
description: "Install the Jazz CLI with one curl command and run your first AI agent in minutes. Single self-contained binary for macOS and Linux: no Node or npm required."
---

# Quick start

How to get from nothing to a working agent.

## 1. Install the CLI

The install script downloads a single self-contained binary for macOS or Linux. It needs no
Node, npm, or any other runtime.

```bash
curl -fsSL https://github.com/lvndry/jazz/releases/latest/download/install.sh | bash
```

It installs to `~/.local/bin` by default, verifies the download against the release
checksums, and tells you if that directory is not on your `PATH`. Override the location with
`JAZZ_INSTALL_DIR`, or pin a version with `JAZZ_VERSION`:

```bash
curl -fsSL https://github.com/lvndry/jazz/releases/latest/download/install.sh |
  JAZZ_VERSION=v0.15.21 JAZZ_INSTALL_DIR="$HOME/bin" bash
```

The variables go after the pipe because they configure `bash`, which runs the script, not
`curl`, which only downloads it.

### Verify where a binary came from

The checksum check proves the download is intact. To prove it was built by this
repository's release workflow, check its build provenance with the GitHub CLI. Every
release binary and its `SHA256SUMS` carry a signed attestation:

```bash
tag="v$(jazz --version)"
gh release download "$tag" --repo lvndry/jazz --pattern 'jazz-darwin-arm64.gz'
gh attestation verify jazz-darwin-arm64.gz --repo lvndry/jazz
```

Swap in the asset for your platform (`jazz-linux-x64.gz`, `jazz-linux-arm64-musl.gz`, and so
on). Releases older than the provenance step have no attestation to check. A passing check names the workflow run that built the
file and the commit it was built from.

Jazz is also on npm, which is the route to use on Windows or on a platform with no published
binary:

```bash
# npm
npm install -g jazz-ai

# bun (--trust lets the postinstall script fetch the platform binary)
bun add -g --trust jazz-ai

# pnpm
pnpm add -g jazz-ai

# yarn
yarn global add jazz-ai
```

`jazz update` upgrades either kind of installation: a binary replaces itself from the GitHub
release, and a package install goes back through the package manager that put it there.

## 2. Start talking to it

```bash
jazz
```

On first run Jazz walks you through provider setup and creates an agent. After that, `jazz`
drops you straight into a conversation.

Jazz itself is free and always will be: it's MIT-licensed with no account and no tiers. The
only variable cost is the model you choose, and there are two ways to make that zero:

- **Start using Jazz for free**: choose [OpenRouter](https://openrouter.ai) and the
  [`Free Models Router`](https://openrouter.ai/openrouter/free) model. No credit card.
- **Keep it entirely local**: choose `ollama`, and the model runs on your machine too.

## 3. Update Jazz

Keep Jazz up to date with the latest features and improvements:

```bash
jazz update
```

Before updating across a minor version, read [Upgrading](../upgrading.md): it explains the
versioning policy and what to change when a release renames a setting.

## Next steps

- **[Creating agents](./create-an-agent.md)**: configure one for a specific job
- **[Surfaces](../surfaces/index.md)**: run the same agent headless, on a schedule, in CI, or in a chat thread
- **[Guides](../guides/index.md)**: copy-pasteable recipes
- **[Concepts](../concepts/index.md)**: learn the vocabulary behind Jazz
