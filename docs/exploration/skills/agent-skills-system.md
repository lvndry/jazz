# Agent Skills System for Jazz

## Overview

Inspired by
[Anthropic's Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills),
this exploration adapts the Skills concept for Jazz's agentic automation platform. Skills package
procedural knowledge, tools, and organizational context into discoverable, composable resources that
agents can load dynamically.

**Core Concept**: Instead of manually configuring tools and instructions for each agent, create
**Skills** - organized folders containing instructions, scripts, and resources that agents discover
and load only when needed.

## What are Agent Skills?

A **Skill** is a directory containing:

- **SKILL.md**: Core instructions and metadata
- **Code/Scripts**: Executable tools and utilities
- **Documentation**: Reference materials and examples
- **Resources**: Templates, configs, data files

```
skills/
├── deployment/
│   ├── SKILL.md           # Core skill definition
│   ├── kubernetes.md      # K8s-specific instructions
│   ├── rollback.md        # Rollback procedures
│   ├── deploy.sh          # Deployment script
│   └── templates/
│       └── deployment.yaml
├── email-management/
│   ├── SKILL.md
│   ├── triage.py          # Email categorization
│   └── templates/
│       └── responses.json
└── code-review/
    ├── SKILL.md
    ├── checklist.md
    └── lint-rules.json
```

## Key Principles

### 1. Progressive Disclosure (Load Only What's Needed)

**Three-level context hierarchy:**

```typescript
// Level 1: Metadata (always loaded)
{
  name: "deployment",
  description: "Deploy applications to Kubernetes",
  tags: ["devops", "kubernetes", "docker"]
}

// Level 2: Core instructions (loaded when skill triggered)
SKILL.md contains:
- When to use this skill
- Available capabilities
- Basic workflows
- References to additional files

// Level 3: Detailed context (loaded as needed)
kubernetes.md, rollback.md, etc.
- Loaded only when specific scenarios arise
- Agent navigates to relevant sections
```

**Benefits for Jazz:**

- ✅ Context window efficiency (don't load everything)
- ✅ Scale to 100+ skills without overwhelming agents
- ✅ Faster responses (less context to process)
- ✅ Lower costs (smaller context = fewer tokens)

### 2. Composability

Skills can reference and build upon each other:

```yaml
# deployment/SKILL.md
---
name: deployment
description: Deploy applications to Kubernetes
dependencies:
  - docker-build
  - kubernetes-ops
  - git-workflows
---
# This skill builds on other skills for complete deployment workflow
```

### 3. Shareability

Skills are portable across teams and projects:

```bash
# Install a skill from a colleague
jazz skills install ./shared-skills/email-triage

# Share your skills
jazz skills export deployment ~/Desktop/deployment-skill.zip

# Install from a skill repository
jazz skills install jazz-community/seo-optimization
```

## Jazz Skills Architecture

### Skill Definition Format

```yaml
# skills/deployment/SKILL.md
---
name: deployment
version: 1.0.0
description: Deploy applications to Kubernetes with rollback capabilities
author: DevOps Team
tags: [devops, kubernetes, docker, deployment]
category: Infrastructure
complexity: intermediate

# Tools this skill uses
tools:
  required: [execute_command, read_file, write_file]
  optional: [git_status, http_request]

# When to trigger this skill
triggers:
  keywords: [deploy, deployment, kubernetes, k8s, rollout]
  patterns:
    - "deploy .* to (production|staging|dev)"
    - "rollback (deployment|release)"
  context_hints:
    - current_directory_contains: ["Dockerfile", "k8s/", "deployment.yaml"]

# Risk level for approval system
risk_level: high

# Documentation structure
sections:
  - deployment_process.md
  - rollback_procedures.md
  - troubleshooting.md
---

# Deployment Skill

This skill helps deploy applications to Kubernetes clusters.

## Capabilities

1. **Deploy to Environment**: Deploy Docker containers to K8s clusters
2. **Rollback**: Roll back to previous deployment
3. **Health Check**: Verify deployment health
4. **Logs**: Fetch and analyze deployment logs

## Prerequisites

Before using this skill, ensure:
- kubectl is configured
- Docker images are built
- Kubernetes manifests exist in k8s/ directory

## Basic Workflow

When user requests deployment:

1. Check git status (ensure clean working tree)
2. Verify Docker image exists
3. Read deployment configuration from k8s/
4. Execute deployment command
5. Monitor rollout status
6. Report results to user

For detailed procedures, see:
- [Deployment Process](deployment_process.md)
- [Rollback Procedures](rollback_procedures.md)

## Code Resources

Use these scripts when needed:
- `deploy.sh`: Main deployment script
- `rollback.sh`: Automated rollback
- `health-check.sh`: Post-deployment verification
```

### Skill Discovery & Loading

```typescript
// src/core/skills/skill-service.ts

export interface SkillMetadata {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author?: string;
  readonly tags: readonly string[];
  readonly category: string;
  readonly complexity: "simple" | "intermediate" | "advanced";
  readonly tools: {
    readonly required: readonly string[];
    readonly optional: readonly string[];
  };
  readonly triggers: {
    readonly keywords: readonly string[];
    readonly patterns: readonly string[];
    readonly context_hints: readonly ContextHint[];
  };
  readonly risk_level: ToolRiskLevel;
  readonly path: string; // Path to skill directory
}

export interface SkillContent {
  readonly metadata: SkillMetadata;
  readonly core: string; // Full SKILL.md content
  readonly sections: Map<string, string>; // Additional files
  readonly scripts: readonly SkillScript[];
}

export interface SkillScript {
  readonly name: string;
  readonly path: string;
  readonly language: "bash" | "python" | "javascript" | "typescript";
  readonly description: string;
  readonly executable: boolean;
}

export interface SkillService {
  /**
   * Scan and index all available skills
   */
  readonly indexSkills: () => Effect.Effect<void, Error>;

  /**
   * Get metadata for all skills (Level 1)
   */
  readonly listSkills: () => Effect.Effect<readonly SkillMetadata[], never>;

  /**
   * Find skills relevant to a query
   */
  readonly findRelevantSkills: (
    query: string,
    context: SkillSelectionContext,
  ) => Effect.Effect<readonly SkillMetadata[], Error, LLMService>;

  /**
   * Load full skill content (Level 2)
   */
  readonly loadSkill: (skillName: string) => Effect.Effect<SkillContent, Error>;

  /**
   * Load specific section from skill (Level 3)
   */
  readonly loadSkillSection: (
    skillName: string,
    sectionName: string,
  ) => Effect.Effect<string, Error>;

  /**
   * Execute skill script
   */
  readonly executeSkillScript: (
    skillName: string,
    scriptName: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<string, Error>;
}

export class DefaultSkillService implements SkillService {
  constructor(
    private readonly skillsDirectory: string,
    private readonly skillIndex: Ref.Ref<Map<string, SkillMetadata>>,
    private readonly loadedSkills: Ref.Ref<Map<string, SkillContent>>,
  ) {}

  indexSkills(): Effect.Effect<void, Error> {
    return Effect.gen(
      function* (this: DefaultSkillService) {
        const skillDirs = yield* Effect.promise(() =>
          fs.readdir(this.skillsDirectory, { withFileTypes: true }),
        );

        const skills = new Map<string, SkillMetadata>();

        for (const dir of skillDirs) {
          if (!dir.isDirectory()) continue;

          const skillPath = path.join(this.skillsDirectory, dir.name);
          const skillMdPath = path.join(skillPath, "SKILL.md");

          if (!(yield* fileExists(skillMdPath))) continue;

          // Parse SKILL.md and extract metadata
          const metadata = yield* parseSkillMetadata(skillMdPath, skillPath);
          skills.set(metadata.name, metadata);
        }

        yield* Ref.set(this.skillIndex, skills);
      }.bind(this),
    );
  }

  findRelevantSkills(
    query: string,
    context: SkillSelectionContext,
  ): Effect.Effect<readonly SkillMetadata[], Error, LLMService> {
    return Effect.gen(
      function* (this: DefaultSkillService) {
        const allSkills = yield* Ref.get(this.skillIndex);
        const llm = yield* LLMServiceTag;

        // Quick filter by keywords/patterns
        const candidates = Array.from(allSkills.values()).filter((skill) =>
          matchesSkillTriggers(skill, query, context),
        );

        if (candidates.length <= 3) {
          return candidates; // Few enough, return all
        }

        // Use LLM to rank and select top skills
        const skillDescriptions = candidates.map((s) => `- ${s.name}: ${s.description}`).join("\n");

        const prompt = `Select the most relevant skills for this query.

Query: "${query}"
Context: ${formatContext(context)}

Available skills:
${skillDescriptions}

Return JSON array of skill names (max 3):
["skill1", "skill2", "skill3"]`;

        const response = yield* llm.chat({
          messages: [{ role: "user", content: prompt }],
          provider: "openai",
          model: "gpt-4o-mini",
        });

        const selectedNames = JSON.parse(response.content) as string[];
        return candidates.filter((s) => selectedNames.includes(s.name));
      }.bind(this),
    );
  }

  loadSkill(skillName: string): Effect.Effect<SkillContent, Error> {
    return Effect.gen(
      function* (this: DefaultSkillService) {
        // Check cache first
        const loaded = yield* Ref.get(this.loadedSkills);
        const cached = loaded.get(skillName);
        if (cached) return cached;

        // Load from disk
        const skills = yield* Ref.get(this.skillIndex);
        const metadata = skills.get(skillName);
        if (!metadata) {
          return yield* Effect.fail(new Error(`Skill not found: ${skillName}`));
        }

        const skillPath = metadata.path;
        const skillMdPath = path.join(skillPath, "SKILL.md");

        // Parse full SKILL.md
        const content = yield* Effect.promise(() => fs.readFile(skillMdPath, "utf-8"));
        const { frontmatter, body } = parseFrontmatter(content);

        // Index additional sections
        const sections = new Map<string, string>();
        if (frontmatter.sections) {
          for (const section of frontmatter.sections) {
            const sectionPath = path.join(skillPath, section);
            if (yield* fileExists(sectionPath)) {
              const sectionContent = yield* Effect.promise(() => fs.readFile(sectionPath, "utf-8"));
              sections.set(section, sectionContent);
            }
          }
        }

        // Index scripts
        const scripts = yield* indexSkillScripts(skillPath);

        const skillContent: SkillContent = {
          metadata,
          core: body,
          sections,
          scripts,
        };

        // Cache it
        yield* Ref.update(this.loadedSkills, (loaded) =>
          new Map(loaded).set(skillName, skillContent),
        );

        return skillContent;
      }.bind(this),
    );
  }
}

function matchesSkillTriggers(
  skill: SkillMetadata,
  query: string,
  context: SkillSelectionContext,
): boolean {
  const queryLower = query.toLowerCase();

  // Check keywords
  if (skill.triggers.keywords.some((kw) => queryLower.includes(kw))) {
    return true;
  }

  // Check patterns
  if (skill.triggers.patterns.some((pattern) => new RegExp(pattern, "i").test(query))) {
    return true;
  }

  // Check context hints
  if (context.currentDirectory && skill.triggers.context_hints) {
    for (const hint of skill.triggers.context_hints) {
      if (hint.current_directory_contains) {
        const dirContents = context.directoryContents || [];
        if (
          hint.current_directory_contains.some((file) => dirContents.some((f) => f.includes(file)))
        ) {
          return true;
        }
      }
    }
  }

  return false;
}
```

## Integration with Agent Runtime

### Enhanced Agent with Skills

```typescript
// src/core/agent/agent-runner-with-skills.ts

export class AgentRunnerWithSkills {
  static run(
    options: AgentRunnerOptions,
  ): Effect.Effect<AgentResponse, Error, LLMService | ToolRegistry | SkillService | LoggerService> {
    return Effect.gen(function* () {
      const { agent, userInput, conversationId } = options;
      const skillService = yield* SkillServiceTag;
      const logger = yield* LoggerServiceTag;

      // Phase 1: Skill Discovery (Level 1 - Metadata only)
      yield* logger.info("Discovering relevant skills", { query: userInput });

      const relevantSkills = yield* skillService.findRelevantSkills(userInput, {
        conversationHistory: options.conversationHistory,
        currentDirectory: process.cwd(),
        agentId: agent.id,
      });

      yield* logger.info("Found relevant skills", {
        skills: relevantSkills.map((s) => s.name),
      });

      // Phase 2: Build System Prompt with Skill Metadata
      const systemPrompt = buildSystemPromptWithSkills(agent, relevantSkills);

      // Phase 3: Run Agent Loop
      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userInput },
      ];

      let iteration = 0;
      const maxIterations = options.maxIterations || 15;
      const loadedSkills = new Set<string>();

      while (iteration < maxIterations) {
        // Call LLM
        const response = yield* llmService.chat({
          messages,
          tools: getAvailableTools(agent, relevantSkills),
          // ... other options
        });

        // Check for skill loading request
        if (response.tool_calls) {
          for (const toolCall of response.tool_calls) {
            if (toolCall.function.name === "load_skill") {
              // Agent wants to load a skill (Level 2)
              const { skill_name } = JSON.parse(toolCall.function.arguments);

              if (!loadedSkills.has(skill_name)) {
                yield* logger.info("Loading skill", { skill: skill_name });

                const skillContent = yield* skillService.loadSkill(skill_name);
                loadedSkills.add(skill_name);

                // Add skill content to conversation
                messages.push({
                  role: "tool",
                  name: "load_skill",
                  content: `Loaded skill: ${skill_name}\n\n${skillContent.core}`,
                  tool_call_id: toolCall.id,
                });

                continue; // Continue loop to process with loaded skill
              }
            } else if (toolCall.function.name === "load_skill_section") {
              // Agent wants specific section (Level 3)
              const { skill_name, section_name } = JSON.parse(toolCall.function.arguments);

              const section = yield* skillService.loadSkillSection(skill_name, section_name);

              messages.push({
                role: "tool",
                name: "load_skill_section",
                content: section,
                tool_call_id: toolCall.id,
              });

              continue;
            } else if (toolCall.function.name === "execute_skill_script") {
              // Agent wants to run skill script
              const { skill_name, script_name, args } = JSON.parse(toolCall.function.arguments);

              const output = yield* skillService.executeSkillScript(skill_name, script_name, args);

              messages.push({
                role: "tool",
                name: "execute_skill_script",
                content: output,
                tool_call_id: toolCall.id,
              });

              continue;
            }

            // Regular tool call
            // ... handle other tools
          }
        }

        // Check if done
        if (response.finish_reason === "stop") {
          return {
            response: response.content,
            iterations: iteration,
            status: "completed",
            // ... other fields
          };
        }

        iteration++;
      }

      return yield* Effect.fail(new Error("Max iterations reached"));
    });
  }
}

function buildSystemPromptWithSkills(agent: Agent, skills: readonly SkillMetadata[]): string {
  const skillsList = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");

  return `${agent.config.systemPrompt || "You are a helpful AI assistant."}

## Available Skills

You have access to the following skills. You can load them as needed:

${skillsList}

To use a skill:
1. Use the load_skill tool to load full skill instructions
2. Use load_skill_section to load specific sections
3. Use execute_skill_script to run skill scripts

Only load skills when you need them for the current task.`;
}
```

## Use Cases for Jazz

### 1. **Deployment Workflows**

**Pain Point**: Each team has different deployment procedures (Docker, K8s, AWS, etc.). Hard to
codify and share.

**Solution**: Deployment Skills

```
skills/deployment/
├── SKILL.md              # Core deployment workflow
├── kubernetes.md         # K8s-specific procedures
├── docker.md             # Docker best practices
├── aws.md                # AWS deployment
├── rollback.md           # Rollback procedures
├── scripts/
│   ├── deploy.sh
│   ├── rollback.sh
│   └── health-check.sh
└── templates/
    ├── deployment.yaml
    └── service.yaml
```

**Usage:**

```
User: "Deploy the app to production"

Agent: [Discovers deployment skill]
Agent: [Loads SKILL.md]
Agent: "I see we're deploying to Kubernetes. Let me check the process..."
Agent: [Loads kubernetes.md]
Agent: [Executes deploy.sh]
Agent: "Deployment successful! Monitoring rollout..."
```

### 2. **Email Management & Triage**

**Pain Point**: Everyone has their own email management style. Hard to replicate across team.

**Solution**: Email Triage Skill

```
skills/email-triage/
├── SKILL.md
├── categorization.md     # How to categorize emails
├── responses.md          # Response templates
├── escalation.md         # When to escalate
├── scripts/
│   ├── triage.py         # ML-based categorization
│   └── auto-reply.py
└── templates/
    └── responses.json
```

**Usage:**

```
User: "Triage my emails"

Agent: [Loads email-triage skill]
Agent: [Runs triage.py to categorize]
Agent: "Found 5 urgent, 12 normal, 8 newsletters"
Agent: [Uses response templates]
Agent: "Drafted replies for 3 urgent emails. Review?"
```

### 3. **Code Review Best Practices**

**Pain Point**: Code review standards vary. New team members don't know what to check.

**Solution**: Code Review Skill

```
skills/code-review/
├── SKILL.md
├── checklist.md          # Review checklist
├── security.md           # Security checks
├── performance.md        # Performance considerations
├── style-guide.md        # Code style rules
└── scripts/
    ├── lint.sh
    └── security-scan.sh
```

**Usage:**

```
User: "Review this PR"

Agent: [Loads code-review skill]
Agent: [Loads checklist.md]
Agent: [Runs lint.sh and security-scan.sh]
Agent: "Code review complete. Found 3 issues:
       1. Potential SQL injection in login.ts
       2. Missing error handling in api.ts
       3. Style: inconsistent naming in utils.ts"
```

### 4. **Onboarding New Developers**

**Pain Point**: Onboarding requires tribal knowledge. Documentation gets outdated.

**Solution**: Onboarding Skill

```
skills/onboarding/
├── SKILL.md
├── setup.md              # Dev environment setup
├── architecture.md       # System architecture
├── conventions.md        # Code conventions
├── tools.md              # Team tools and workflows
└── scripts/
    └── setup-env.sh
```

**Usage:**

```
New Dev: "How do I get started?"

Agent: [Loads onboarding skill]
Agent: "Let me help you set up. First, I'll..."
Agent: [Runs setup-env.sh]
Agent: "Environment ready! Here's our architecture..."
Agent: [References architecture.md]
```

### 5. **Incident Response**

**Pain Point**: When things break, responders need quick access to runbooks and procedures.

**Solution**: Incident Response Skill

```
skills/incident-response/
├── SKILL.md
├── severity-levels.md
├── escalation.md
├── runbooks/
│   ├── database-down.md
│   ├── high-cpu.md
│   └── api-errors.md
└── scripts/
    ├── diagnose.sh
    └── notify-team.sh
```

**Usage:**

```
User: "Database is down!"

Agent: [Loads incident-response skill]
Agent: [Loads database-down.md runbook]
Agent: [Runs diagnose.sh]
Agent: "Detected: Database connection pool exhausted"
Agent: [Follows runbook steps]
Agent: [Executes notify-team.sh]
Agent: "Team notified. Restarting connection pool..."
```

### 6. **Customer Support**

**Pain Point**: Support agents need product knowledge, FAQs, and escalation paths.

**Solution**: Support Skill

```
skills/customer-support/
├── SKILL.md
├── common-issues.md
├── escalation-matrix.md
├── product-docs/
│   ├── features.md
│   └── troubleshooting.md
└── templates/
    └── responses.json
```

### 7. **Data Analysis Workflows**

**Pain Point**: Analysts run similar queries and reports repeatedly.

**Solution**: Analytics Skill

```
skills/analytics/
├── SKILL.md
├── common-queries.md
├── visualization.md
└── scripts/
    ├── daily-report.py
    ├── user-metrics.sql
    └── export-csv.py
```

### 8. **Security Auditing**

**Pain Point**: Security checks are manual and inconsistent.

**Solution**: Security Audit Skill

```
skills/security-audit/
├── SKILL.md
├── vulnerability-scanning.md
├── compliance-checklist.md
├── penetration-testing.md
└── scripts/
    ├── scan-dependencies.sh
    ├── check-secrets.py
    └── audit-permissions.sh
```

## Implementation Path

### Phase 1: Core Infrastructure (Week 1-2)

**Goal**: Basic skill loading and execution

```typescript
// Minimal implementation
interface Skill {
  name: string;
  description: string;
  content: string;
}

class BasicSkillService {
  async loadSkill(name: string): Promise<Skill> {
    const content = await fs.readFile(`skills/${name}/SKILL.md`, "utf-8");
    return { name, description: "", content };
  }
}
```

**Features**:

- [ ] Skill directory structure
- [ ] SKILL.md parser (frontmatter + body)
- [ ] Basic skill indexing
- [ ] Skill loading API
- [ ] Integration with agent runner

**Deliverable**: Agent can load and use a simple skill

### Phase 2: Progressive Disclosure (Week 3)

**Goal**: Efficient context management

**Features**:

- [ ] Three-level context hierarchy
- [ ] Lazy loading of sections
- [ ] Skill discovery based on triggers
- [ ] Load only relevant parts

**Deliverable**: Agent loads skills dynamically based on query

### Phase 3: Script Execution (Week 4)

**Goal**: Skills can include executable code

**Features**:

- [ ] Script indexing
- [ ] Safe script execution
- [ ] Permission system integration
- [ ] Output capture and formatting

**Deliverable**: Agent can execute skill scripts

### Phase 4: Skill Management (Week 5)

**Goal**: User-friendly skill management

**Features**:

- [ ] CLI commands (`jazz skills list`, `install`, `create`)
- [ ] Skill validation
- [ ] Dependency management
- [ ] Version control

**Deliverable**: Users can manage skills via CLI

### Phase 5: Skill Marketplace (Week 6+)

**Goal**: Share and discover skills

**Features**:

- [ ] Skill repository
- [ ] Skill search and discovery
- [ ] Community ratings
- [ ] Auto-updates

**Deliverable**: Ecosystem of shareable skills

## CLI Commands

```bash
# List available skills
$ jazz skills list

📚 Available Skills (8):

Deployment (v1.0.0)
  Deploy applications to Kubernetes
  Tags: devops, kubernetes, docker

Email Triage (v1.2.0)
  Intelligent email management and categorization
  Tags: email, productivity, automation

Code Review (v1.1.0)
  Automated code review with best practices
  Tags: development, code-quality, security

# View skill details
$ jazz skills info deployment

📋 Skill: deployment

Version: 1.0.0
Author: DevOps Team
Category: Infrastructure
Complexity: intermediate

Description:
  Deploy applications to Kubernetes with rollback capabilities

Capabilities:
  • Deploy to multiple environments
  • Automated rollback on failure
  • Health monitoring
  • Log aggregation

Required Tools:
  execute_command, read_file, write_file

Scripts:
  deploy.sh - Main deployment script
  rollback.sh - Automated rollback
  health-check.sh - Post-deployment verification

# Create a new skill
$ jazz skills create my-skill

Creating new skill: my-skill
✅ Created skills/my-skill/
✅ Created SKILL.md template
✅ Created scripts/ directory

Edit skills/my-skill/SKILL.md to define your skill

# Install a skill
$ jazz skills install ./team-skills/incident-response
✅ Installed: incident-response (v1.0.0)

# Install from URL
$ jazz skills install https://github.com/jazz-skills/seo-optimization
✅ Downloaded and installed: seo-optimization (v2.0.0)

# Test a skill
$ jazz skills test deployment --query "deploy to production"

Testing skill: deployment

✓ Skill metadata loaded
✓ Triggers matched: ["deploy", "production"]
✓ Required tools available
✓ Scripts validated

Simulation:
  User: "deploy to production"
  → Skill would load: deployment/SKILL.md
  → Would execute: deploy.sh
  → Estimated tokens: ~1,500

# Export a skill
$ jazz skills export deployment ~/Desktop/
✅ Exported to: ~/Desktop/deployment-skill.zip

# Validate a skill
$ jazz skills validate ./skills/deployment

Validating skill: deployment

✓ SKILL.md exists
✓ Frontmatter valid
✓ All referenced files exist
✓ Scripts executable
✓ No security issues

Skill is valid! ✅
```

## Skill Template

```yaml
# skills/template/SKILL.md
---
name: my-skill
version: 1.0.0
description: Brief description of what this skill does
author: Your Name
tags: [tag1, tag2, tag3]
category: General
complexity: simple

tools:
  required: [read_file, write_file]
  optional: []

triggers:
  keywords: [keyword1, keyword2]
  patterns:
    - "pattern.*regex"
  context_hints:
    - current_directory_contains: ["file.txt"]

risk_level: low

sections:
  - advanced.md
  - examples.md
---

# My Skill

Brief introduction to what this skill does and when to use it.

## Capabilities

List what this skill can do:
1. Capability one
2. Capability two
3. Capability three

## Prerequisites

What needs to be set up or configured:
- Prerequisite 1
- Prerequisite 2

## Basic Workflow

Step-by-step process:

1. First step
2. Second step
3. Third step

## Examples

We've created comprehensive, production-ready skill examples to demonstrate the Agent Skills system:

### 📚 [View All Examples](./examples/README.md)

**Available Skills:**

1. **[Deployment Skill](./examples/deployment-skill.md)** - Automate the entire deployment pipeline
2. **[Email Triage Skill](./examples/email-triage-skill.md)** - Intelligent email categorization and management
3. **[Code Review Skill](./examples/code-review-skill.md)** - Automated security, performance, and style analysis
4. **[Incident Response Skill](./examples/incident-response-skill.md)** - Rapid incident response with runbooks
5. **[Data Analysis Skill](./examples/data-analysis-skill.md)** - Data exploration, analysis, and visualization
6. **[Content Creation Skill](./examples/content-creation-skill.md)** - Content generation and SEO optimization

Each example includes:
- Complete SKILL.md with metadata
- Executable scripts and utilities
- Real-world usage examples
- Best practices and configuration
- Integration patterns

## Additional Resources

See [Advanced Usage](advanced.md) for more details.
```

## Integration with Existing Jazz Features

### 1. **Skills + Dynamic Tool Loading**

Skills can specify which tools they need, complementing dynamic tool loading:

```yaml
# Skill declares tools
tools:
  required: [git_status, git_commit]
  optional: [git_push]
# Dynamic loader ensures tools are available
# When skill is loaded, tools are loaded too
```

### 2. **Skills + Workflows**

Skills can define reusable workflow patterns:

```yaml
# skills/deployment/SKILL.md
workflows:
  - name: safe-deploy
    steps:
      - git_status
      - run_tests
      - docker_build
      - deploy
      - health_check
```

### 3. **Skills + Memory**

Skills can learn and improve:

```typescript
// After using deployment skill successfully
memoryService.recordSkillUsage({
  skill: "deployment",
  success: true,
  approach: "kubernetes with health checks",
  duration: 120000,
});

// Next time, skill can reference past successes
```

### 4. **Skills + Approval Policies**

Skills declare their risk level:

```yaml
risk_level: high  # Requires approval

# Approval system respects skill risk
if (skill.risk_level === "high") {
  requireApproval();
}
```

### 5. **Skills + Scheduled Agents**

Scheduled agents can use skills:

```typescript
// Scheduled agent with skill
{
  schedule: "daily-at-9am",
  skills: ["email-triage", "reporting"],
  prompt: "Process emails and generate daily report"
}
```

## Benefits for Jazz Users

### For Individual Users

✅ **Codify Expertise**: Capture your workflows once, reuse forever ✅ **Consistency**: Same process
every time ✅ **Learning**: Onboard new tools and workflows faster ✅ **Efficiency**: Don't repeat
instructions

### For Teams

✅ **Knowledge Sharing**: Share workflows across team ✅ **Standardization**: Everyone follows same
procedures ✅ **Onboarding**: New members get up to speed faster ✅ **Best Practices**: Encode team
standards

### For Organizations

✅ **Compliance**: Ensure processes are followed ✅ **Scalability**: Scale knowledge across teams ✅
**Security**: Centralize security procedures ✅ **Audit**: Track what procedures were used

## Security Considerations

### Skill Sandboxing

```typescript
// Skills run in restricted environment
const sandbox = {
  allowedPaths: ["./", "/tmp"],
  disallowedCommands: ["rm -rf /", "sudo"],
  networkAccess: "restricted",
};
```

### Skill Verification

```bash
# Verify skill before installation
$ jazz skills verify ./untrusted-skill

Verifying skill: untrusted-skill

⚠️  Security Issues:
  • Script makes network requests to unknown domains
  • Attempts to read ~/.ssh/id_rsa
  • Uses sudo command

Recommendation: Do not install this skill
```

### Signed Skills

```typescript
// Skills can be cryptographically signed
interface SignedSkill {
  skill: Skill;
  signature: string;
  signedBy: string;
  trustedAuthority: boolean;
}
```

## Comparison: Skills vs. Tools vs. Workflows

| Feature            | Tools             | Skills                     | Workflows            |
| ------------------ | ----------------- | -------------------------- | -------------------- |
| **Granularity**    | Single action     | Multiple tools + knowledge | Predefined sequence  |
| **Flexibility**    | High              | High                       | Low                  |
| **Context**        | Minimal           | Rich procedural knowledge  | Step-by-step         |
| **Composability**  | ✅                | ✅                         | ⚠️                   |
| **Shareability**   | ⚠️                | ✅                         | ✅                   |
| **Learning Curve** | Simple            | Moderate                   | Simple               |
| **Best For**       | Atomic operations | Domain expertise           | Repeatable processes |

**The Relationship**:

- **Tools** are building blocks
- **Skills** combine tools with knowledge
- **Workflows** are predefined sequences

```
Tools → Skills → Workflows
(atoms)  (molecules) (recipes)
```

## Real-World Example: Complete Deployment Skill

See [Deployment Skill Example](./examples/deployment-skill.md) for a complete, production-ready
skill.

## Future Vision

### Self-Improving Skills

Skills that learn and optimize:

```typescript
// After 10 successful deployments
skill.optimizeWorkflow({
  pattern: "Users always run tests before deploy",
  suggestion: "Auto-run tests in deployment skill",
});
```

### AI-Generated Skills

Let agents create skills:

```
User: "Create a skill for our React deployment process"
Agent: [Observes React deployments]
Agent: [Generates SKILL.md]
Agent: "I've created a skill. Review?"
```

### Skill Composition

Combine skills automatically:

```typescript
// Combine multiple skills
const compositeSkill = composeSkills(["git-workflows", "docker-build", "kubernetes-deploy"]);
```

## Summary

**Agent Skills for Jazz** solve critical scaling challenges:

1. **Package Knowledge**: Codify expertise into reusable units
2. **Progressive Loading**: Load only what's needed (context efficiency)
3. **Composability**: Build complex capabilities from simple skills
4. **Shareability**: Share knowledge across teams and projects
5. **Scalability**: Handle 100+ specialized capabilities

**Start Simple**: Basic skill loading (Week 1-2) **Evolve**: Progressive disclosure, script
execution (Week 3-4) **Scale**: Skill marketplace, AI-generated skills (Week 6+)

Skills are the **missing piece** that transforms Jazz from a tool platform into a **knowledge
platform**! 🚀
