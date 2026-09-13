---
name: dependency-audit
description: Weekly list of outdated and vulnerable dependencies, with the upgrades worth doing first.
schedule: "0 8 * * 1"
autoApprove: read-only
maxIterations: 30
maxCostUSD: 0.50
author: jazz
tags: [dependencies, security, engineering]
---

# Dependency audit

Audit this repository's dependencies. Read only; do not install, upgrade, or edit lockfiles.

## Detect the toolchain

Look for a lockfile and use the matching commands:

| Lockfile                           | Outdated                                 | Vulnerabilities            |
| ---------------------------------- | ---------------------------------------- | -------------------------- |
| `bun.lock` / `bun.lockb`           | `bun outdated`                           | `bun audit`                |
| `package-lock.json`                | `npm outdated --json`                    | `npm audit --json`         |
| `pnpm-lock.yaml`                   | `pnpm outdated --json`                   | `pnpm audit --json`        |
| `yarn.lock`                        | `yarn outdated --json`                   | `yarn npm audit --json`    |
| `Cargo.lock`                       | `cargo outdated` if installed, else skip | `cargo audit` if installed |
| `poetry.lock` / `requirements.txt` | `pip list --outdated`                    | `pip-audit` if installed   |

If a command is not installed, say so in one line and move on.

## Report

Reply with one Markdown document:

1. **Fix first**: vulnerabilities with a fix available, highest severity first. Package, current
   version, fixed version, one line on the advisory.
2. **Major bumps waiting**: packages a major version behind, with the count of releases skipped.
   Flag anything the repository imports in more than ten files.
3. **Routine**: minor and patch updates, as one compact list.
4. **Since `{schedule.lastRunAt}`**: what is new compared with the last audit, if the window is
   not empty. Skip this section on the first run.

Do not recommend upgrading everything. Name the three upgrades with the best risk-to-effort ratio.
