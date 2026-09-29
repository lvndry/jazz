---
description: "Install the Jazz CLI with one curl command and run your first AI agent in minutes. Single self-contained binary for macOS and Linux: no Node or npm required."
---

# Quick start

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
on).

Jazz is also on npm, which installs the same macOS or Linux binary through your package
manager:

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

Windows is not supported natively, by the installer or by npm. Install Jazz inside
[WSL2](https://learn.microsoft.com/windows/wsl/install) with the `curl` command above; it
behaves there as it does on any Linux machine.

## 2. Start talking to it

```bash
jazz
```

On first run Jazz welcomes you, lists any provider API keys it found in your environment, and
asks whether to turn on desktop notifications. It then opens the home menu: choose **Create
agent** to pick a provider and model and name the agent. Every later `jazz` opens the same
menu, where **New conversation** starts talking to an agent and **Resume conversation** picks
up an earlier one. To skip the menu, run `jazz agent chat <agent-name>`.

Jazz itself is free and always will be: it's MIT-licensed with no account and no tiers. The
only variable cost is the model you choose, and there are two ways to make that zero:

- **Start using Jazz for free**: choose [OpenRouter](https://openrouter.ai) and the
  [`Free Models Router`](https://openrouter.ai/openrouter/free) model. No credit card.
- **Keep it entirely local**: choose `ollama`, and the model runs on your machine too.

## 3. Update Jazz

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
