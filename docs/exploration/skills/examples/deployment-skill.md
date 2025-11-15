# Example: Complete Deployment Skill

This is a production-ready skill that demonstrates all key concepts of Jazz's Agent Skills system.

## Directory Structure

```
skills/deployment/
├── SKILL.md                    # This file - core skill definition
├── environments.md             # Environment-specific procedures
├── rollback.md                 # Rollback procedures
├── troubleshooting.md          # Common issues and solutions
├── scripts/
│   ├── deploy.sh              # Main deployment script
│   ├── rollback.sh            # Rollback script
│   ├── health-check.sh        # Post-deployment verification
│   └── notify-team.py         # Send notifications
├── templates/
│   ├── deployment.yaml        # K8s deployment template
│   ├── service.yaml           # K8s service template
│   └── ingress.yaml          # K8s ingress template
└── configs/
    ├── production.json        # Production configuration
    └── staging.json           # Staging configuration
```

## SKILL.md

````yaml
---
name: deployment
version: 1.2.0
description: Deploy containerized applications to Kubernetes clusters with automated health checks and rollback capabilities
author: DevOps Team <devops@company.com>
tags: [devops, kubernetes, docker, deployment, automation]
category: Infrastructure
complexity: intermediate

# Tools this skill requires
tools:
  required:
    - execute_command      # Run shell commands
    - read_file           # Read configs and manifests
    - write_file          # Update deployment files
    - git_status          # Verify clean working tree
  optional:
    - git_log            # Check recent changes
    - http_request       # Call deployment APIs
    - send_email         # Notify stakeholders

# When should this skill be triggered?
triggers:
  keywords:
    - deploy
    - deployment
    - kubernetes
    - k8s
    - rollout
    - release
  patterns:
    - "deploy .* to (production|staging|dev|qa)"
    - "release .* to (prod|stage)"
    - "rollback (?:the )?deployment"
    - "check deployment (status|health)"
  context_hints:
    - current_directory_contains:
        - "Dockerfile"
        - "k8s/"
        - "kubernetes/"
        - "deployment.yaml"
        - ".dockerignore"
    - git_repository: true

# Risk level for approval system
risk_level: high
approval_required: true

# Documentation structure (loaded progressively)
sections:
  - environments.md
  - rollback.md
  - troubleshooting.md

# Skill metadata
estimated_duration: 5-15 minutes
prerequisites:
  - kubectl configured
  - Docker daemon running
  - Access to container registry
  - Valid Kubernetes context

last_updated: 2024-01-15
---

# Deployment Skill

This skill provides comprehensive deployment capabilities for containerized applications running on Kubernetes.

## Overview

Deploying to Kubernetes involves multiple steps that must be executed correctly and in order. This skill automates the entire deployment process while maintaining safety through health checks and providing easy rollback capabilities if issues arise.

## Core Capabilities

1. **Pre-Deployment Validation**
   - Verify git working tree is clean
   - Check Docker image exists
   - Validate Kubernetes manifests
   - Confirm correct cluster context

2. **Container Build & Push**
   - Build Docker image with proper tagging
   - Push to container registry
   - Verify image accessibility

3. **Kubernetes Deployment**
   - Apply deployments, services, ingress
   - Monitor rollout status
   - Wait for pods to be ready

4. **Health Verification**
   - Run health check endpoints
   - Verify pod logs
   - Check service availability

5. **Rollback on Failure**
   - Automatic rollback if health checks fail
   - Manual rollback command
   - Preserve previous deployment

6. **Notifications**
   - Notify team on deployment start
   - Alert on completion or failure
   - Send deployment summary

## Prerequisites

Before using this skill, ensure:

1. **Kubernetes Access**
   ```bash
   kubectl cluster-info
   kubectl get nodes
````

2. **Docker Running**

   ```bash
   docker ps
   ```

3. **Registry Authentication**

   ```bash
   docker login registry.company.com
   ```

4. **Required Files Exist**
   - `Dockerfile` in project root
   - Kubernetes manifests in `k8s/` directory
   - Configuration files (optional)

## Basic Deployment Workflow

When a user requests deployment, follow this process:

### Step 1: Validate Environment

First, verify the environment is ready:

```typescript
// Check git status
const gitStatus = await executeTool("git_status", {});
if (gitStatus.hasChanges) {
  warn("Working tree has uncommitted changes. Recommend committing first.");
  // Ask user if they want to continue
}

// Verify Docker is running
const dockerCheck = await executeTool("execute_command", {
  command: "docker ps",
});
```

### Step 2: Determine Target Environment

Extract the target environment from user's request:

- "production" / "prod" → Use production configuration
- "staging" / "stage" → Use staging configuration
- "development" / "dev" → Use development configuration

```typescript
const environment = detectEnvironment(userInput);
// Load environment-specific config
const config = await readFile(`configs/${environment}.json`);
```

### Step 3: Build Docker Image

Build the Docker image with appropriate tagging:

```bash
# Execute scripts/deploy.sh
./scripts/deploy.sh build <environment>
```

This script will:

- Build Docker image
- Tag with version and environment
- Push to registry

### Step 4: Apply Kubernetes Manifests

Deploy to Kubernetes:

```bash
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml (if exists)
```

Monitor the rollout:

```bash
kubectl rollout status deployment/<app-name> -n <namespace>
```

### Step 5: Verify Deployment Health

Run health checks using `scripts/health-check.sh`:

```bash
./scripts/health-check.sh <environment> <app-name>
```

This verifies:

- All pods are running
- Health endpoints respond
- No errors in recent logs

### Step 6: Rollback if Issues Detected

If health checks fail:

```bash
./scripts/rollback.sh <environment> <app-name>
```

This will:

- Roll back to previous deployment
- Verify rollback succeeded
- Notify team of failure

### Step 7: Notify Team

On success:

```bash
./scripts/notify-team.py --success \
  --environment <environment> \
  --version <version> \
  --deployed-by <user>
```

On failure:

```bash
./scripts/notify-team.py --failure \
  --environment <environment> \
  --error "<error-message>"
```

## Environment-Specific Considerations

For environment-specific procedures, see [environments.md](environments.md).

## Rollback Procedures

If deployment fails or issues are discovered post-deployment, see [rollback.md](rollback.md) for
detailed rollback procedures.

## Troubleshooting

For common issues and solutions, see [troubleshooting.md](troubleshooting.md).

## Safety Checks

Before proceeding with deployment:

⚠️ **Production Deployments**

- Require explicit approval
- Verify user has production access
- Confirm deployment window (working hours only)
- Check if maintenance window is active

⚠️ **Git Status**

- Warn if working tree is dirty
- Recommend committing or stashing changes

⚠️ **Image Verification**

- Ensure Docker image was built successfully
- Verify image is pushed to registry
- Check image tag matches expected version

## Success Criteria

A deployment is considered successful when:

1. ✅ All pods reach "Running" status
2. ✅ Health check endpoints return 200 OK
3. ✅ No errors in pod logs (last 50 lines)
4. ✅ Service is accessible via load balancer
5. ✅ Resource usage is within normal limits

## Failure Handling

If any step fails:

1. **Stop the deployment process**
2. **Capture error details** (logs, status, error messages)
3. **Execute rollback** if deployment was partially applied
4. **Notify team** with failure details
5. **Provide next steps** to user

## Example Usage

### Example 1: Deploy to Production

```
User: "Deploy to production"

Agent: [Loads deployment skill]
Agent: "⚠️ Production deployment requires approval. This will deploy to the production cluster."
Agent: "Current version: v1.2.3"
Agent: "Do you want to proceed? [y/n]"

User: "y"

Agent: [Checks git status]
Agent: "✅ Working tree is clean"
Agent: [Builds Docker image]
Agent: "🔨 Building Docker image..."
Agent: "✅ Image built: registry.company.com/myapp:v1.2.3"
Agent: [Pushes to registry]
Agent: "📤 Pushing to registry..."
Agent: "✅ Image pushed successfully"
Agent: [Applies K8s manifests]
Agent: "🚀 Deploying to production..."
Agent: "⏳ Waiting for rollout to complete..."
Agent: [Monitors rollout]
Agent: "✅ Rollout complete. All pods running."
Agent: [Runs health checks]
Agent: "🏥 Running health checks..."
Agent: "✅ All health checks passed"
Agent: [Notifies team]
Agent: "📧 Team notified of successful deployment"
Agent: "✨ Deployment to production complete! Version v1.2.3 is now live."
```

### Example 2: Deploy to Staging

```
User: "Deploy to staging"

Agent: [Loads deployment skill]
Agent: "Deploying to staging environment..."
Agent: [Executes deployment process]
Agent: "✅ Deployment to staging complete!"
Agent: "URL: https://staging.myapp.com"
```

### Example 3: Rollback

```
User: "Rollback the deployment"

Agent: [Loads deployment skill]
Agent: [Loads rollback.md]
Agent: "Rolling back to previous version..."
Agent: [Executes rollback script]
Agent: "✅ Rolled back to v1.2.2"
Agent: "All pods are healthy"
```

## Code Resources

This skill includes several scripts in the `scripts/` directory:

### deploy.sh

Main deployment script that handles the complete deployment process.

**Usage:**

```bash
./scripts/deploy.sh <environment> [options]

Options:
  --skip-build    Skip Docker build step
  --skip-push     Skip registry push
  --dry-run       Show what would be deployed
  --no-verify     Skip health checks
```

### rollback.sh

Automated rollback script.

**Usage:**

```bash
./scripts/rollback.sh <environment> <app-name>
```

### health-check.sh

Post-deployment health verification.

**Usage:**

```bash
./scripts/health-check.sh <environment> <app-name>
```

Returns exit code 0 on success, non-zero on failure.

### notify-team.py

Send deployment notifications via Slack/email.

**Usage:**

```bash
# Success notification
./scripts/notify-team.py --success \
  --environment prod \
  --version v1.2.3 \
  --deployed-by john@company.com

# Failure notification
./scripts/notify-team.py --failure \
  --environment prod \
  --error "Health checks failed"
```

## Configuration Files

### configs/production.json

```json
{
  "cluster": "production-cluster",
  "namespace": "prod",
  "replicas": 3,
  "registry": "registry.company.com",
  "image_name": "myapp",
  "health_check_url": "https://api.myapp.com/health",
  "timeout": 600,
  "notification": {
    "slack_channel": "#deployments",
    "email": ["team@company.com"]
  }
}
```

### configs/staging.json

```json
{
  "cluster": "staging-cluster",
  "namespace": "staging",
  "replicas": 2,
  "registry": "registry.company.com",
  "image_name": "myapp",
  "health_check_url": "https://staging-api.myapp.com/health",
  "timeout": 300,
  "notification": {
    "slack_channel": "#staging-deployments"
  }
}
```

## Metrics & Monitoring

Track these metrics for each deployment:

- **Deployment Duration**: Time from start to completion
- **Build Time**: Docker image build duration
- **Rollout Time**: Time for pods to become ready
- **Success Rate**: Percentage of successful deployments
- **Rollback Rate**: Percentage of deployments rolled back

## Best Practices

1. **Always deploy to staging first**
   - Validate changes in staging
   - Run integration tests
   - Confirm before production

2. **Use semantic versioning**
   - Tag images with proper versions
   - Include git commit SHA
   - Use `latest` tag cautiously

3. **Monitor after deployment**
   - Watch logs for first 10 minutes
   - Check error rates in APM
   - Verify key metrics

4. **Communicate deployments**
   - Notify team before production deploys
   - Share deployment notes
   - Document any manual steps

5. **Keep rollback ready**
   - Test rollback procedures regularly
   - Keep previous version available
   - Have rollback plan documented

## Related Skills

This skill works well with:

- **git-workflows**: For pre-deployment git operations
- **docker-build**: For advanced Docker build scenarios
- **kubernetes-ops**: For cluster management tasks
- **monitoring**: For post-deployment monitoring

## Changelog

### v1.2.0 (2024-01-15)

- Added automatic rollback on health check failure
- Improved notification system
- Added dry-run mode

### v1.1.0 (2023-12-01)

- Added support for multiple environments
- Improved health check reliability
- Added configuration file support

### v1.0.0 (2023-11-01)

- Initial release
- Basic deployment workflow
- Kubernetes integration

````

## Additional Files

### environments.md

```markdown
# Environment-Specific Deployment Procedures

## Production

**Critical Considerations:**

- ⚠️ **Always get approval** before deploying to production
- ⚠️ **Deploy during business hours** (9am-5pm PST)
- ⚠️ **Announce in #deployments** channel 5 minutes before
- ⚠️ **Have rollback plan ready**

**Configuration:**
- Cluster: production-cluster
- Namespace: prod
- Replicas: 3 (for high availability)
- Resource limits: High

**Post-Deployment:**
- Monitor for 15 minutes after deployment
- Check Datadog for anomalies
- Verify key user flows work

## Staging

**Purpose:** Pre-production testing environment

**Configuration:**
- Cluster: staging-cluster
- Namespace: staging
- Replicas: 2
- Resource limits: Medium

**Testing Checklist:**
- [ ] Core API endpoints work
- [ ] Database migrations successful
- [ ] Third-party integrations functional
- [ ] Authentication flows work

## Development

**Purpose:** Active development and testing

**Configuration:**
- Cluster: dev-cluster
- Namespace: dev
- Replicas: 1
- Resource limits: Low

**Fast Iteration:**
- Auto-deploy on git push
- Skip certain health checks
- Use aggressive caching
````

### rollback.md

````markdown
# Rollback Procedures

## When to Rollback

Rollback immediately if:

- ❌ Health checks fail
- ❌ Error rate spikes above 1%
- ❌ Response time degrades significantly
- ❌ Critical functionality broken
- ❌ Data corruption detected

## Automatic Rollback

The deployment skill includes automatic rollback if health checks fail within the first 5 minutes.

## Manual Rollback

If issues are discovered after deployment succeeds:

```bash
# Quick rollback to previous version
./scripts/rollback.sh production myapp

# Rollback to specific version
./scripts/rollback.sh production myapp --version v1.2.2
```
````

## Rollback Process

1. **Stop incoming traffic** (optional)

   ```bash
   kubectl scale deployment myapp --replicas=0 -n prod
   ```

2. **Revert to previous deployment**

   ```bash
   kubectl rollout undo deployment/myapp -n prod
   ```

3. **Verify rollback succeeded**

   ```bash
   kubectl rollout status deployment/myapp -n prod
   ./scripts/health-check.sh production myapp
   ```

4. **Restore traffic**

   ```bash
   kubectl scale deployment myapp --replicas=3 -n prod
   ```

5. **Notify team**
   ```bash
   ./scripts/notify-team.py --rollback \
     --environment production \
     --reason "Health checks failed"
   ```

## Post-Rollback

- Investigate what went wrong
- Create incident report
- Fix issues in development
- Test thoroughly before next deployment

````

### troubleshooting.md

```markdown
# Troubleshooting Common Deployment Issues

## Issue: Image Pull Error

**Symptoms:**
- Pods stuck in "ImagePullBackOff"
- Error: "Failed to pull image"

**Solutions:**
1. Verify image exists in registry
2. Check registry authentication
3. Confirm image tag is correct

## Issue: Pods Crash on Startup

**Symptoms:**
- Pods in "CrashLoopBackOff"
- Frequent restarts

**Solutions:**
1. Check pod logs: `kubectl logs <pod-name> -n <namespace>`
2. Verify environment variables are set
3. Check database connectivity
4. Verify configuration files

## Issue: Health Checks Fail

**Symptoms:**
- Health check returns non-200 status
- Timeout errors

**Solutions:**
1. Check health endpoint manually: `curl <health-url>`
2. Verify pod is actually running
3. Check application logs
4. Verify database connections

## Issue: Rollout Stuck

**Symptoms:**
- Rollout doesn't progress
- New pods not created

**Solutions:**
1. Check for resource constraints
2. Verify node capacity
3. Check pod scheduling errors
4. Review deployment events

## Getting Help

If issues persist:
1. Check #devops channel
2. Review deployment logs
3. Contact DevOps team
4. Create incident ticket
````

---

This example demonstrates how a complete, production-ready skill packages:

- ✅ Metadata and triggers
- ✅ Step-by-step procedures
- ✅ Executable scripts
- ✅ Configuration files
- ✅ Progressive disclosure (main skill → environments → rollback → troubleshooting)
- ✅ Safety checks and approval requirements
- ✅ Error handling and rollback
- ✅ Team communication

Users can install this skill and immediately have sophisticated deployment capabilities! 🚀
