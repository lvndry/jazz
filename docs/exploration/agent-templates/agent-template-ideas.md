# Agent Template Ideas

## Overview

This document explores specialized agent templates that would extend Jazz's capabilities beyond the current default, Gmail, and Coder agents. Each template is designed for specific domains and use cases, providing users with pre-configured expertise and behaviors optimized for particular workflows.

## Why Specialized Templates Matter

**Current State:**

- Users must manually configure agents with appropriate tools and prompts
- Generic agents require extensive context to understand domain-specific requirements
- Users spend time crafting prompts for common use cases

**With Specialized Templates:**

- **Instant Expertise**: Pre-configured agents with domain knowledge built-in
- **Better Results**: Templates optimized for specific tasks produce higher quality outputs
- **Faster Onboarding**: Users can start productive workflows immediately
- **Consistent Patterns**: Standardized approaches to common problems
- **Tool Optimization**: Templates know which tools to use and how to use them effectively

## Template Categories

### 🔬 High-Priority Templates

These templates address the most common and impactful use cases for Jazz users.

---

## 1. Research Agent

**Template ID:** `research`

**Description:**
An agent specialized in information gathering, web research, and synthesizing findings into actionable insights.

### Why This Is Useful

**Problem Solved:**

- Developers and professionals spend hours researching APIs, best practices, and solutions
- Information is scattered across multiple sources
- Research findings need to be synthesized and documented

**Value to Jazz Users:**

- **Time Savings**: Automate research tasks that take hours
- **Comprehensive Coverage**: Search multiple sources systematically
- **Documentation**: Automatically save findings in organized formats
- **Current Information**: Access real-time data via web search
- **API Integration**: Research APIs and generate integration code

**Real-World Use Cases:**

- "Research the Stripe Payment Intents API and create integration code"
- "Find best practices for TypeScript error handling"
- "Compare top 3 project management tools and create a report"
- "Research security vulnerabilities in our dependencies"
- "Find examples of Effect-TS patterns for async workflows"

**Primary Tools:**

- Web Search (Linkup/Exa)
- HTTP (for API exploration)
- File Management (for saving research)
- Git (for committing research artifacts)

**Key Behaviors:**

- Systematic information gathering from multiple sources
- Cross-referencing and fact-checking
- Structured output formatting (reports, summaries, comparisons)
- Source attribution and citation
- Research artifact organization

**Example Interaction:**

```
User: Research the latest TypeScript 5.5 features and create a migration guide

Agent: [Searches multiple sources]
✓ Found TypeScript 5.5 release notes
✓ Analyzed 12 blog posts and articles
✓ Reviewed GitHub discussions

Created: docs/typescript-5.5-migration.md
- New features summary
- Breaking changes
- Migration checklist
- Code examples
```

---

## 2. DevOps Agent

**Template ID:** `devops`

**Description:**
An agent specialized in deployment, infrastructure management, CI/CD pipelines, and system operations.

### Why This Is Useful

**Problem Solved:**

- Deployment processes are complex and error-prone
- Infrastructure changes require careful coordination
- CI/CD pipelines need constant maintenance
- Cost optimization requires ongoing analysis

**Value to Jazz Users:**

- **Deployment Automation**: Coordinate complex multi-step deployments
- **Infrastructure Management**: Analyze and optimize cloud resources
- **CI/CD Maintenance**: Update and fix pipeline configurations
- **Cost Optimization**: Identify and implement cost-saving opportunities
- **Environment Management**: Handle staging, production, and development environments

**Real-World Use Cases:**

- "Deploy latest main to staging with pre-deployment checks"
- "Analyze AWS infrastructure and suggest cost optimizations"
- "Fix the failing CI pipeline"
- "Create a deployment checklist for production release"
- "Set up monitoring alerts for high CPU usage"

**Primary Tools:**

- Git (for version control)
- Shell (for deployment commands)
- File Management (for config files)
- HTTP (for cloud service APIs)

**Key Behaviors:**

- Pre-deployment validation (tests, migrations, checks)
- Step-by-step deployment coordination
- Rollback planning and execution
- Infrastructure analysis and recommendations
- Cost analysis and optimization suggestions

**Example Interaction:**

```
User: Deploy latest main to staging

Agent: Pre-deployment checks...
✓ All tests passing
✓ No pending migrations
✓ Latest commit: abc123 "feat: add notifications"

Starting deployment:
1. Build → ✓ (2m 34s)
2. Migrations → ⚠️ 2 pending migrations found
3. Deploy → ✓ Application deployed
4. Smoke tests → ✓ All passing

Deployment complete! Duration: 4m 12s
```

---

## 3. Security Agent

**Template ID:** `security`

**Description:**
An agent specialized in security scanning, vulnerability detection, and security best practices enforcement.

### Why This Is Useful

**Problem Solved:**

- Security vulnerabilities are discovered too late
- Hardcoded secrets are accidentally committed
- Dependencies have known CVEs
- Security best practices are inconsistently applied

**Value to Jazz Users:**

- **Proactive Security**: Find vulnerabilities before they're exploited
- **Secret Detection**: Prevent credential leaks
- **Dependency Audits**: Keep dependencies secure
- **Compliance**: Enforce security standards automatically
- **Threat Analysis**: Understand and mitigate security risks

**Real-World Use Cases:**

- "Scan codebase for hardcoded secrets and API keys"
- "Check dependencies for known security vulnerabilities"
- "Find SQL injection risks in the codebase"
- "Audit authentication and authorization code"
- "Generate security best practices report"

**Primary Tools:**

- File Management (grep for patterns, read files)
- Git (for scanning commit history)
- Shell (for security scanning tools)
- Web Search (for CVE lookups)

**Key Behaviors:**

- Pattern-based vulnerability detection
- CVE database lookups
- Risk assessment and prioritization
- Automated fix suggestions
- Security report generation

**Example Interaction:**

```
User: Scan for security issues and fix critical ones

Agent: 🔒 Security Audit Report

🔴 Critical Issues (2):
1. Hardcoded API Key (src/config/api.ts:12)
   Fix: Move to environment variable

2. SQL Injection Risk (src/api/search.ts:45)
   Fix: Use parameterized queries

Should I fix these automatically?

[User approves]

✓ Fixed API key → environment variable
✓ Fixed SQL injection → parameterized query
✓ Added input sanitization
✓ All tests passing
```

---

## 4. Documentation Agent

**Template ID:** `docs`

**Description:**
An agent specialized in creating, maintaining, and organizing technical documentation.

### Why This Is Useful

**Problem Solved:**

- Documentation is often outdated or missing
- Writing documentation is time-consuming
- Documentation quality is inconsistent
- Finding relevant documentation is difficult

**Value to Jazz Users:**

- **Automated Generation**: Generate docs from code and commits
- **Consistency**: Maintain consistent documentation standards
- **Completeness**: Ensure all features are documented
- **Organization**: Keep documentation well-structured
- **Time Savings**: Reduce documentation writing time significantly

**Real-World Use Cases:**

- "Generate a README from the project structure"
- "Create API documentation from code comments"
- "Generate a changelog from git commits since last tag"
- "Update documentation for the new authentication feature"
- "Create architecture documentation for the project"

**Primary Tools:**

- File Management (read/write docs)
- Git (for commit history, changelogs)
- Web Search (for documentation standards)

**Key Behaviors:**

- Code analysis for API documentation
- Commit history analysis for changelogs
- Template-based documentation generation
- Cross-referencing and linking
- Format consistency (Markdown, structure)

**Example Interaction:**

```
User: Generate a changelog for all commits since the last tag

Agent: Last tag: v1.2.0 (30 days ago)
Found 47 commits since then

# Changelog v1.3.0

## 🚀 Features (12)
- Add user profile customization (#145)
- Implement dark mode toggle (#148)

## 🐛 Bug Fixes (18)
- Fix memory leak in dashboard (#143)

## 📚 Documentation (8)
- Update API documentation (#144)

Should I save this as CHANGELOG.md?
```

---

## 5. Testing Agent

**Template ID:** `testing`

**Description:**
An agent specialized in writing tests, analyzing test coverage, and ensuring code quality through testing.

### Why This Is Useful

**Problem Solved:**

- Writing tests is time-consuming
- Test coverage gaps go unnoticed
- Tests become outdated as code changes
- Test quality varies significantly

**Value to Jazz Users:**

- **Test Generation**: Automatically generate tests for new code
- **Coverage Analysis**: Identify untested code paths
- **Test Maintenance**: Update tests when code changes
- **Quality Assurance**: Ensure comprehensive test coverage
- **Test Refactoring**: Improve existing test suites

**Real-World Use Cases:**

- "Generate unit tests for the new authentication module"
- "Analyze test coverage and suggest improvements"
- "Fix all failing tests in the test suite"
- "Add integration tests for the payment API"
- "Refactor tests to use better patterns"

**Primary Tools:**

- File Management (read/write test files)
- Git (for test history)
- Shell (for running tests, coverage tools)

**Key Behaviors:**

- Code analysis for test generation
- Test pattern recognition
- Coverage gap identification
- Test execution and debugging
- Test refactoring suggestions

**Example Interaction:**

```
User: Generate tests for src/auth/jwt.ts

Agent: [Analyzes code structure]
✓ Identified 8 functions to test
✓ Found existing test patterns
✓ Generated comprehensive test suite

Created: tests/auth/jwt.test.ts
- 12 unit tests
- Edge case coverage
- Error handling tests
- Mock setup included

Running tests... ✓ All passing (12/12)
```

---

### 🔧 Medium-Priority Templates

These templates address valuable but more specialized use cases.

---

## 6. Data Analysis Agent

**Template ID:** `data`

**Description:**
An agent specialized in analyzing data, generating reports, and extracting insights from structured and unstructured data.

### Why This Is Useful

**Problem Solved:**

- Log files and metrics are difficult to analyze manually
- Data insights require time-consuming analysis
- Reports need to be generated regularly
- Pattern detection in data is complex

**Value to Jazz Users:**

- **Log Analysis**: Parse and analyze application logs
- **Performance Metrics**: Analyze system performance data
- **Report Generation**: Create regular status reports
- **Pattern Detection**: Find anomalies and trends
- **Data Transformation**: Convert data between formats

**Real-World Use Cases:**

- "Analyze error logs from the last 24 hours and create a report"
- "Find performance bottlenecks in the metrics data"
- "Generate a weekly performance report"
- "Detect anomalies in user activity data"
- "Convert CSV data to JSON format"

**Primary Tools:**

- File Management (read data files)
- Shell (for data processing tools)
- HTTP (for API data)

**Key Behaviors:**

- Data parsing and validation
- Statistical analysis
- Pattern recognition
- Report formatting
- Visualization suggestions

---

## 9. Refactoring Agent

**Template ID:** `refactor`

**Description:**
An agent specialized in code refactoring, pattern migration, and code quality improvements.

### Why This Is Useful

**Problem Solved:**

- Codebases accumulate technical debt
- Pattern migrations are time-consuming
- Refactoring is risky and error-prone
- Code quality degrades over time

**Value to Jazz Users:**

- **Pattern Migration**: Migrate to new patterns systematically
- **Code Modernization**: Update code to current standards
- **Cross-Repository Refactoring**: Refactor across multiple repos
- **Technical Debt Reduction**: Systematically reduce debt
- **Quality Improvements**: Improve code quality metrics

**Real-World Use Cases:**

- "Refactor all Logger usage to LoggerService across the codebase"
- "Migrate callback patterns to async/await"
- "Extract common patterns into shared utilities"
- "Remove deprecated API usage"
- "Improve code quality in the authentication module"

**Primary Tools:**

- File Management (read/write code)
- Git (for version control)
- Shell (for analysis tools)

**Key Behaviors:**

- Pattern detection
- Impact analysis
- Incremental refactoring
- Test validation
- Change documentation

---

## 10. Release Manager Agent

**Template ID:** `release`

**Description:**
An agent specialized in version management, changelog generation, and release coordination.

### Why This Is Useful

**Problem Solved:**

- Release processes are manual and error-prone
- Changelogs are incomplete or missing
- Version management is inconsistent
- Release coordination is complex

**Value to Jazz Users:**

- **Automated Releases**: Coordinate release processes
- **Changelog Generation**: Generate comprehensive changelogs
- **Version Management**: Handle version bumping correctly
- **Release Notes**: Create detailed release notes
- **Coordination**: Coordinate releases across teams

**Real-World Use Cases:**

- "Generate a changelog for v1.3.0 release"
- "Prepare a release: bump version, update changelog, create tag"
- "Create release notes from PR descriptions"
- "Coordinate the release process for production"
- "Update version numbers across all package files"

**Primary Tools:**

- Git (for tags, commits, branches)
- File Management (for changelogs, version files)
- Gmail (for release announcements)

**Key Behaviors:**

- Commit analysis
- Version calculation
- Changelog formatting
- Tag management
- Release coordination

---

## 11. System Administration Agent

**Template ID:** `adminsys`

**Description:**
An agent specialized in operating system management, network configuration, system hardening, and infrastructure administration.

### Why This Is Useful

**Problem Solved:**

- System administration tasks are complex and error-prone
- Security hardening requires deep expertise
- Network configuration is tedious and risky
- System monitoring and maintenance is time-consuming
- OS-level optimizations require specialized knowledge

**Value to Jazz Users:**

- **System Hardening**: Implement security best practices automatically
- **Network Management**: Configure and troubleshoot network settings
- **OS Optimization**: Optimize system performance and resource usage
- **Maintenance Automation**: Automate routine system maintenance tasks
- **Security Compliance**: Ensure systems meet security standards
- **Infrastructure Management**: Manage system-level infrastructure efficiently

**Real-World Use Cases:**

- "Harden this macOS system following security best practices"
- "Configure firewall rules to block unauthorized access"
- "Analyze system logs for security threats and anomalies"
- "Optimize system performance by identifying resource bottlenecks"
- "Set up automated backups for critical system files"
- "Configure network interfaces and routing tables"
- "Audit system permissions and fix insecure file permissions"
- "Set up system monitoring and alerting"
- "Implement disk encryption and secure boot configuration"
- "Manage system services and daemons"

**Primary Tools:**

- Shell (for system commands, network tools, OS utilities)
- File Management (for system configuration files)
- Git (for version controlling system configs)
- Web Search (for security advisories, best practices)

**Key Behaviors:**

- **Security-First Approach**: Prioritize security in all operations
- **System Analysis**: Deep understanding of OS internals and network stack
- **Configuration Management**: Version control and backup system configs
- **Risk Assessment**: Evaluate impact before making system changes
- **Compliance Checking**: Verify systems meet security standards
- **Performance Tuning**: Optimize system resources and services
- **Audit Trail**: Log all system changes for accountability
- **Rollback Planning**: Always plan for reverting changes

**Safety Considerations:**

- **Critical Operations**: System-level changes require explicit approval
- **Backup Strategy**: Always backup before modifying system configs
- **Impact Analysis**: Understand consequences before executing commands
- **Privilege Escalation**: Handle sudo/root operations with extreme care
- **Network Changes**: Network modifications can cause connectivity loss
- **Service Management**: Stopping critical services can disrupt operations

**Example Interaction:**

```
User: Harden this macOS system for production use

Agent: 🔒 System Hardening Analysis

Current Security Status:
- Firewall: Disabled
- FileVault: Not enabled
- System Integrity Protection: Enabled
- Automatic Updates: Enabled

⚠️ Security Recommendations:
1. Enable firewall with stealth mode
2. Enable FileVault disk encryption
3. Disable unnecessary services (AirPlay, Bluetooth sharing)
4. Configure secure SSH settings
5. Set up automatic security updates
6. Audit file permissions in /usr/local

Should I proceed with these hardening steps?

[User approves]

✓ Enabled firewall with stealth mode
✓ Configured FileVault encryption (requires restart)
✓ Disabled unnecessary services
✓ Hardened SSH configuration
✓ Set up automatic security updates
✓ Audited and fixed insecure file permissions

⚠️ System restart required for FileVault to take effect
Backup created at: ~/system-backup-2024-01-15.tar.gz
```

**Advanced Capabilities:**

- **Network Hardening**: Configure firewalls, VPNs, and network segmentation
- **Service Management**: Start, stop, and configure system services
- **User Management**: Create, modify, and secure user accounts
- **Disk Management**: Partition, encrypt, and optimize disk usage
- **Log Analysis**: Parse and analyze system logs for security events
- **Package Management**: Install, update, and secure system packages
- **Kernel Tuning**: Optimize kernel parameters for performance
- **Container Security**: Harden Docker/Kubernetes environments
- **Compliance Auditing**: Check systems against CIS benchmarks, NIST guidelines

---

### Implementation Pattern

Each template follows this structure:

```typescript
// src/core/agent/prompts/{template-id}/v1.ts
export const {TEMPLATE}_PROMPT_V1 = `
You are {agentName}, {domain-specific expertise description}.
${SHARED_CONTEXT}

## Core Identity
[Domain-specific expertise and principles]

## Cardinal Rules
[Domain-specific rules and constraints]

${SMART_EXPLORATION}
${SMART_TOOL_USAGE}

## Workflow
[Domain-specific workflow patterns]

## Tool Operations
[How to use tools for this domain]

## Safety Protocol
[Domain-specific safety requirements]

${CLI_OUTPUT_FORMATTING}
`;
```

### Template Registration

```typescript
// src/core/agent/agent-prompt.ts
this.templates = {
  // ... existing templates
  research: {
    name: "Research Agent",
    description: "An agent specialized in information gathering...",
    systemPrompt: RESEARCH_PROMPT_V1,
    userPromptTemplate: "{userInput}",
  },
  adminsys: {
    name: "System Administration Agent",
    description:
      "An agent specialized in OS management, network configuration, and system hardening.",
    systemPrompt: ADMINSYS_PROMPT_V1,
    userPromptTemplate: "{userInput}",
  },
  // ... other templates
};
```

---

## Success Metrics

### User Adoption

- % of users creating agents with specialized templates
- Template usage frequency
- User satisfaction ratings

### Quality Metrics

- Task completion rate by template
- Error rate reduction vs. generic agents
- Time-to-completion improvements

### Impact Metrics

- Time saved per task
- Tasks completed per user
- Template-specific success stories

---

## Future Considerations

### Template Customization

- Allow users to extend templates with custom prompts
- Template inheritance and composition
- User-contributed templates

### Template Discovery

- Template recommendations based on user needs
- Template marketplace
- Community-contributed templates

### Template Analytics

- Track template performance
- Identify improvement opportunities
- A/B testing for prompt variations

---

## Questions for Discussion

1. **Template Granularity**: Should templates be more specific (e.g., `security-scanning` vs `security`) or more general?
2. **Template Composition**: Should users be able to combine templates (e.g., `coder` + `testing`)?
3. **Template Versioning**: How should template updates be handled?
4. **Community Templates**: Should Jazz support user-contributed templates?
5. **Template Selection**: Should Jazz recommend templates based on user intent?
