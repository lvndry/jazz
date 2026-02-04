# Jazz Homebrew Tap

This directory contains the Homebrew formula for Jazz CLI.

## For Users

### Install Jazz via Homebrew

```bash
# Add the tap
brew tap lvndry/jazz

# Install Jazz
brew install jazz
```

### Update Jazz

```bash
brew upgrade jazz
```

### Uninstall

```bash
brew uninstall jazz
brew untap lvndry/jazz
```

## For Maintainers

### Creating the Homebrew Tap

1. Create a new GitHub repository named `homebrew-jazz` (must start with `homebrew-`)
2. Copy `jazz.rb` to the root of that repository
3. Users can then install with `brew tap lvndry/jazz && brew install jazz`

### Updating the Formula

When releasing a new version:

1. Update the `version` field in `jazz.rb`
2. Update the download URLs to point to the new release
3. Update the SHA256 checksums:

```bash
# Download each binary and calculate checksums
curl -L https://github.com/lvndry/jazz/releases/download/v0.8.1/jazz-darwin-arm64 -o jazz-darwin-arm64
shasum -a 256 jazz-darwin-arm64

curl -L https://github.com/lvndry/jazz/releases/download/v0.8.1/jazz-darwin-x64 -o jazz-darwin-x64
shasum -a 256 jazz-darwin-x64

# Repeat for Linux binaries
```

4. Commit and push to the tap repository

### Automated Updates

The GitHub Actions workflow in `.github/workflows/release.yml` includes a placeholder for automating Homebrew formula updates. To implement:

1. Create a GitHub token with repo access
2. Add it as `HOMEBREW_TAP_TOKEN` secret
3. Update the workflow to automatically push formula updates to the tap repo

## Directory Structure

```
homebrew/
├── README.md          # This file
└── jazz.rb           # Homebrew formula template
```

## Resources

- [Homebrew Formula Cookbook](https://docs.brew.sh/Formula-Cookbook)
- [How to Create a Homebrew Tap](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap)
