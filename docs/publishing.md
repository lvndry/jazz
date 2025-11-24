## Publishing Jazz to npm

This repo publishes automatically when a GitHub release is created from a semver tag. Follow this
checklist any time you cut a new version.

### 1. Prepare the release locally

- Start from a clean `main` and ensure tests/builds pass (`bun run test`, `bun run build`).
- Run one of:
  - `npm version patch`
  - `npm version minor`
  - `npm version major`
- The `npm version` command updates `package.json`, commits the bump, and creates a tag like
  `v0.0.0`.

### 2. Push the commit and tag

- Push both the commit and the tag: `git push --follow-tags`.
- Verify the tag exists on GitHub before proceeding.

### 3. Create the GitHub release

- On GitHub, draft a new release using the tag you just pushed.
- Add concise release notes (highlights, fixes, breaking changes).
- Publish the release; the `Publish Package` workflow (`.github/workflows/publish.yml`) triggers
  automatically because it listens to `release.published` events.

### 4. Monitor the workflow

- Watch the Actions tab to ensure the `Publish Package` job succeeds. It checks out the tagged
  commit, installs deps, builds, and runs `npm publish`.
- If it fails, fix the issue, retag/release as needed (you may delete the release/tag and redo the
  process).

### 5. Verify on npm

- After the workflow reports success, confirm the new version exists on
  [npmjs.com/package/jazz-ai](https://www.npmjs.com/package/jazz-ai).

### Tips

- Never edit files directly on GitHub after tagging; always recreate the tag if the code changes.
- Keep release notes in sync with the npm changelog (if you maintain one) to reduce confusion for
  users.
