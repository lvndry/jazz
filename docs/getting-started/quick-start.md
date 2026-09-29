---
description: "Install the Jazz CLI with one curl command and run your first AI agent in minutes. Single self-contained binary for macOS and Linux: no Node or npm required."
---

# Quick start

## 1. Install the CLI

The install script downloads a self-contained binary for macOS or Linux. No runtime is
required. On Windows, run it inside [WSL2](https://learn.microsoft.com/windows/wsl/install).

```bash
curl -fsSL https://github.com/lvndry/jazz/releases/latest/download/install.sh | bash
```

The binary installs to `~/.local/bin`. If the installer reports that this directory is
missing from your `PATH`, follow its instructions before continuing.

## 2. Create your first agent

Open a terminal in a project directory or a folder of files you want Jazz to work with:

```bash
jazz
```

On first run Jazz welcomes you, lists any provider API keys it found in your environment, and
asks whether to turn on desktop notifications. Choose **Start setup** to pick a provider
and model, select a persona, and name your agent. For a hosted provider, supply its API key
when asked; [Model providers](../configure/providers.md) explains how to get credentials.
Jazz opens a conversation when setup finishes.

On later runs, `jazz` shows your agents and a message box. Pick an agent and type a message
to start a conversation, or use `/resume` to continue an earlier one. To open a specific
agent directly, run `jazz agent chat <agent-name>`.

Jazz is free and MIT-licensed. Model providers may charge for usage. To start
without a paid API model:

- **Start using Jazz for free**: choose [OpenRouter](https://openrouter.ai) and the
  [`Free Models Router`](https://openrouter.ai/openrouter/free) model. No credit card.
- **Run locally**: start [Ollama with a tool-capable model](./local-models.md), then choose
  `ollama` during setup.

## 3. Give it a task

During setup, choose the `default` persona and name your agent `assistant`.
The conversation opens automatically.

Try this prompt:

```text
Read the files in this directory and explain what this project does.
List the main parts and how to get started. Do not change any files.
```

Jazz shows the tools the agent calls as it reads. You can ask follow-up questions in the
same conversation, or give it a task such as:

```text
Write a GETTING-STARTED.md based on what you found. Include the setup commands
and explain how to run the project.
```

When Jazz asks for approval, review the proposed change and approve or reject it.
You can continue refining the result in the same conversation. To return later, run `jazz`
and enter `/resume`.

## 4. Update Jazz

```bash
jazz update
```

Before updating across a minor version, read [Upgrading](../upgrading.md): it explains the
versioning policy and what to change when a release renames a setting.

## Other installation options

Override the installation directory with `JAZZ_INSTALL_DIR`, or pin a version with
`JAZZ_VERSION`:

```bash
curl -fsSL https://github.com/lvndry/jazz/releases/latest/download/install.sh |
  JAZZ_VERSION=v0.15.21 JAZZ_INSTALL_DIR="$HOME/bin" bash
```

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

### Verify where a binary came from

The checksum check proves the download is intact. To prove it was built by this
repository's release workflow, check its build provenance with the GitHub CLI. Release
binaries with signed attestations can be checked as follows:

```bash
tag="v$(jazz --version)"
gh release download "$tag" --repo lvndry/jazz --pattern 'jazz-darwin-arm64.gz'
gh attestation verify jazz-darwin-arm64.gz --repo lvndry/jazz
```

Swap in the asset for your platform (`jazz-linux-x64.gz`, `jazz-linux-arm64-musl.gz`, and so
on).

## Next steps

- **[CLI](../surfaces/cli.md)**: conversations, attachments, approvals, and run controls
- **[CLI reference](../commands.md)**: all commands and flags
- **[Creating agents](./create-an-agent.md)**: configure one for a specific job
- **[Surfaces](../surfaces/index.md)**: run the same agent headless, on a schedule, in CI, or in a chat thread
- **[Guides](../guides/index.md)**: copy-pasteable recipes
- **[Concepts](../concepts/index.md)**: learn the vocabulary behind Jazz
