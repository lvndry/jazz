# Use Case: Weekly Security Audit

## Overview

Automate a weekly check of your infrastructure or security news and get a briefing delivered to you.

## Prerequisites

- **Jazz CLI** installed.
- **Deep Research** skill (for news) or **SSH/Log** access (for infra checks).

## Setup

1. **Create a Workflow File**:
   Create a file named `security-audit.workflow.md`:

   ```markdown
   # Weekly Security Briefing

   1. Search for "latest distinct CVEs and security vulnerabilities in Node.js, Docker, and Kubernetes from the last 7 days".
   2. Summarize the findings into a concise list grouped by severity (Critical, High, Medium).
   3. Check if any apply to our stack (Node.js 20, Docker, AWS ECS).
   4. Save the report to `docs/security/weekly-updates/{date}.md`.
   ```

2. **Schedule the Workflow**:
   Schedule this to run every Monday at 9 AM.

   ```bash
   jazz workflow schedule security-audit --cron "0 9 * * 1" --file ./security-audit.workflow.md
   ```

3. **Sit Back**:
   Jazz will now run this every Monday morning. You can check the logs or output files.

## Advanced: Infrastructure Checks

You can also ask Jazz to run scripts or check logs if you give it CLI access.
_"Check `/var/log/auth.log` for failed login attempts in the last 24 hours."_
