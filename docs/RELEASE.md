# Jazz CLI Release Guide

This guide explains how to create a new release of Jazz CLI.

## Prerequisites

- Push access to the repository
- npm publish access (for npm releases)
- GitHub token configured for releases

## Release Process

### 1. Prepare the Release

1. Ensure all changes are committed and pushed
2. Update version in `package.json` if needed
3. Update `CHANGELOG.md` (if you maintain one)
4. Run tests to ensure everything works:
   ```bash
   bun test
   bun run build
   ```

### 2. Create and Push a Version Tag

Use the Makefile commands to bump version and create a tag:

```bash
# For patch releases (0.8.1 -> 0.8.2)
make patch

# For minor releases (0.8.1 -> 0.9.0)
make minor

# For major releases (0.8.1 -> 1.0.0)
make major
```

These commands will:

- Bump the version in `package.json`
- Create a git tag
- Push the tag to GitHub

### 3. Automated Release Process

Once the tag is pushed, GitHub Actions will automatically:

1. **Build binaries** for multiple platforms:
   - macOS (Intel and Apple Silicon)
   - Linux (x64)

2. **Generate checksums** for all binaries

3. **Create a GitHub Release** with:
   - All platform binaries
   - Checksums file
   - Auto-generated release notes

4. **Publish to npm** (requires `NPM_TOKEN` secret)

### 4. Update Homebrew Formula (Manual)

After the release is created:

1. Download the new binaries and calculate SHA256 checksums:

   ```bash
   VERSION=0.8.2  # Replace with actual version

   curl -L "https://github.com/lvndry/jazz/releases/download/v${VERSION}/jazz-darwin-arm64" -o jazz-darwin-arm64
   shasum -a 256 jazz-darwin-arm64

   curl -L "https://github.com/lvndry/jazz/releases/download/v${VERSION}/jazz-darwin-x64" -o jazz-darwin-x64
   shasum -a 256 jazz-darwin-x64
   ```

2. Update `homebrew/jazz.rb`:
   - Update `version` field
   - Update download URLs
   - Update SHA256 checksums

3. If you have a Homebrew tap repository (`homebrew-jazz`):
   - Copy the updated formula to the tap repo
   - Commit and push

## Manual Release (Alternative)

If you need to create a release manually:

```bash
# 1. Build binaries locally
make compile

# 2. Create a tag
git tag -a v0.8.2 -m "Release v0.8.2"
git push origin v0.8.2

# 3. Create GitHub release manually via web UI
# Upload the binary from dist/jazz

# 4. Publish to npm
npm publish
```

## Troubleshooting

### Build Fails on GitHub Actions

- Check the Actions logs for specific errors
- Ensure all dependencies are properly listed in `package.json`
- Verify the compilation script works locally

### npm Publish Fails

- Ensure `NPM_TOKEN` secret is set in GitHub repository settings
- Verify you have publish access to the `jazz-ai` package
- Check if the version already exists on npm

### Binary Doesn't Work

- Test the binary locally before releasing
- Ensure all external dependencies are properly marked
- Check platform-specific issues (macOS code signing, etc.)

## Post-Release

1. Announce the release on Discord/social media
2. Update documentation if needed
3. Monitor for issues from users
4. Consider creating a blog post for major releases

## GitHub Secrets Required

For the automated release process to work, ensure these secrets are set:

- `GITHUB_TOKEN` - Automatically provided by GitHub Actions
- `NPM_TOKEN` - Your npm authentication token (for publishing)
- `HOMEBREW_TAP_TOKEN` - (Optional) For automated Homebrew formula updates
