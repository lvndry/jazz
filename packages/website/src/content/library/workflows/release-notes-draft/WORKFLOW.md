---
name: release-notes-draft
description: A draft changelog entry for everything merged since the last git tag, written for users rather than for the people who wrote the code.
autoApprove: read-only
maxIterations: 40
maxCostUSD: 1.00
author: jazz
tags: [release, changelog, git, engineering]
---

# Release notes draft

Draft the release notes for the next version of this repository. Read only; reply with the draft,
do not write a file or tag anything.

## Range

From the most recent tag to `HEAD`: `git describe --tags --abbrev=0` gives the tag, then
`git log <tag>..HEAD --no-merges --format='%h %s (%an)'`. If `gh` is available, prefer the
merged pull requests in that range:
`gh pr list --state merged --search "merged:>$(git log -1 --format=%cI <tag>)" --json number,title,body,labels,author`.

## Write

Follow the existing `CHANGELOG.md` style if there is one. Otherwise use these sections, dropping
any that are empty:

- **Breaking changes**: what stops working, and the one-line migration.
- **New**: features, described by what a user can now do, not by the code that does it.
- **Fixed**: bugs, described by the symptom the user saw.
- **Internal**: refactors and tooling, in one compact list.

Each bullet links its pull request as `#123`. Squash several pull requests into one bullet when
they are one change to the user. Leave out dependency bumps unless they change behaviour.

## Then

After the draft, add a short **Needs a human** list: anything you could not classify, anything
whose pull request body contradicts its title, and any change that looks like it should have
been marked breaking.
