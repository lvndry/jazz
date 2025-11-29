# Intelligent Deployment Pipeline

Coordinate complex deployments with pre-checks, migrations, and smoke tests.

## Example

**Ask:** `"Deploy latest main to staging"`

**Jazz will:**

1. Run pre-deployment checks (tests, migrations, etc.)
2. Build the application
3. Apply database migrations (with approval)
4. Deploy to the target environment
5. Run smoke tests to verify deployment
6. Report deployment status

## Setup

Create an agent with shell, git, and file system tools:

```bash
jazz agent create
# Name: deployment-assistant
# Tools: Shell, Git, File System
```

## Usage

```bash
jazz agent chat deployment-assistant
```

Then ask Jazz to deploy. Jazz will:

- Run pre-deployment checks
- Build and deploy the application
- Ask for approval before dangerous operations (migrations, production deploys)
- Run smoke tests
- Report the deployment status

## Example Output

```
You: Deploy latest main to staging

Agent: Pre-deployment checks...

✓ All tests passing on main
✓ No pending migrations
✓ Latest commit: abc123 "feat: add notifications"

Starting staging deployment:

Step 1: Build
✓ Build successful (2m 34s)

Step 2: Database Migrations
Found 2 pending migrations.
⚠️ Apply migrations to staging database?

You: yes

Agent: ✓ Applied migrations successfully

Step 3: Deploy Application
⚠️ About to deploy to staging.app.company.com
Will cause ~30s downtime. Proceed?

You: yes

Agent: ✓ Uploaded assets to S3
✓ Updated container image
✓ Restarted application servers
✓ Health check passed

Step 4: Smoke Tests
✓ Homepage loads (201ms)
✓ API health: OK
✓ Database connectivity: OK

✓ Deployment Complete!
Duration: 4m 12s
```

## More Examples

- `"Deploy to production with all safety checks"`
- `"Deploy feature branch to staging"`
- `"Rollback to previous deployment"`
- `"Deploy with zero downtime"`

## Tips

- Jazz runs comprehensive pre-deployment checks
- All dangerous operations require explicit approval
- Smoke tests verify the deployment was successful
- Jazz can handle rollbacks if deployment fails



