# Complex Task Implementation: A Deep Dive

## Overview

This document investigates how complex agent workflows described in the product vision (Social Media Manager, Blog Content Agent, Infrastructure Monitor, Security Scanner) would be implemented in Jazz's current architecture. We analyze the gap between the vision and current capabilities, identify implementation patterns, and propose a roadmap.

## Current Architecture Analysis

### Agent System

Jazz currently supports two agent paradigms:

1. **AI Agents** (`agentType: "ai-agent"`): Conversational agents that use LLMs to make autonomous decisions and call tools dynamically
2. **Task Agents** (`agentType: "default"`): Traditional automation agents with predefined task sequences

### Task System

The current task system supports these types:

```typescript
type TaskType = "command" | "script" | "api" | "file" | "webhook" | "custom" | "gmail";
```

**Current Task Execution Model:**

- Tasks are defined declaratively in `AgentConfig.tasks`
- Tasks can have dependencies (execution order)
- Tasks support retry policies
- Tasks are executed sequentially (no parallel execution yet)
- Task results are stored but not passed between tasks as variables

**Limitations:**

- No variable substitution between tasks (`{{post}}`, `{{image}}` won't work)
- No conditional execution (`when: "high_cpu"`)
- No dynamic task generation
- Limited task types (no `llm`, `unsplash`, `twitter`, `linkedin`, etc.)

### Tool System

**Current Tools Available:**

- **Gmail**: `list_emails`, `get_email`, `send_email`, `search_emails`, label management
- **File System**: `read_file`, `write_file`, `ls`, `cd`, `grep`, `find`, etc.
- **Shell**: `execute_command`, `execute_command_approved`
- **Git**: `git_status`, `git_log`, `git_diff`, `git_add`, `git_commit`, `git_push`, etc.
- **HTTP**: `http_request` (generic HTTP client)
- **Search**: `web_search`

**Missing Tools for Vision Examples:**

- Social media APIs (Twitter/X, LinkedIn, Instagram)
- Image services (Unsplash, image generation)
- CMS platforms (WordPress, Notion)
- Monitoring tools (Prometheus, Kubernetes)
- Security tools (nmap, OWASP ZAP)
- SEO tools
- Calendar/meeting tools (Zoom, Google Calendar)

### Scheduling System

**Current State:**

- `AgentConfig.schedule` exists but is not fully implemented
- Exploration document exists for scheduled agents (cron-based execution)
- No active scheduler service

**What's Needed:**

- Scheduler service implementation
- Cron expression parsing
- Execution history tracking
- Notification system

### LLM Integration

**Current State:**

- Multi-provider support (OpenAI, Anthropic, Google, Mistral, xAI, DeepSeek)
- Tool calling support
- Streaming support
- Context management

**What Works:**

- Agents can use LLM tools to generate content
- Agents can make decisions based on context
- Agents can chain tool calls

**Limitations:**

- No built-in "llm" task type (would need to be a tool or custom task)
- No template variable substitution in prompts
- No structured output parsing

## Vision Examples: Implementation Analysis

### 1. Social Media Manager

**Vision Example:**

```bash
jazz agent create --name "social-manager" --type "ai-agent" \
  --tools "llm,unsplash,twitter,linkedin" \
  --schedule "daily-at-8am" \
  --config '{
    "tasks": [
      {"type": "llm", "prompt": "Generate engaging social media post about {{topic}}"},
      {"type": "unsplash", "action": "search-image", "query": "{{post_topic}}"},
      {"type": "twitter", "action": "tweet", "content": "{{post}}", "image": "{{image}}"},
      {"type": "linkedin", "action": "post", "content": "{{post}}", "image": "{{image}}"}
    ]
  }'
```

**Current Implementation Approach:**

#### Option A: AI Agent with Tools (Recommended)

This aligns with Jazz's current architecture:

```typescript
// Agent configuration
const socialManagerAgent: Agent = {
  name: "social-manager",
  config: {
    agentType: "ai-agent",
    llmProvider: "openai",
    llmModel: "gpt-4o",
    tools: [
      "llm_generate_content", // New tool
      "unsplash_search_image", // New tool
      "twitter_post_tweet", // New tool
      "linkedin_create_post", // New tool
    ],
    schedule: {
      type: "cron",
      value: "0 8 * * *", // Daily at 8am
      enabled: true,
    },
    environment: {
      TOPIC: "{{topic}}", // Would need template resolution
    },
  },
};
```

**Required New Tools:**

1. **`llm_generate_content` Tool**

   ```typescript
   function createLLMGenerateContentTool(): Tool {
     return defineTool({
       name: "llm_generate_content",
       description: "Generate social media content using LLM",
       parameters: Schema.Struct({
         prompt: Schema.String,
         format: Schema.optional(Schema.Literal("twitter", "linkedin", "instagram")),
         tone: Schema.optional(Schema.String),
         maxLength: Schema.optional(Schema.Number),
       }),
       handler: (args, context) => {
         // Use LLM service to generate content
         // Return structured content object
       },
     });
   }
   ```

2. **`unsplash_search_image` Tool**

   ```typescript
   function createUnsplashSearchImageTool(): Tool {
     return defineTool({
       name: "unsplash_search_image",
       description: "Search and retrieve images from Unsplash",
       parameters: Schema.Struct({
         query: Schema.String,
         orientation: Schema.optional(Schema.Literal("landscape", "portrait", "squarish")),
       }),
       handler: async (args, context) => {
         // Call Unsplash API
         // Return image URL and metadata
       },
     });
   }
   ```

3. **`twitter_post_tweet` Tool** (High Risk - Approval Required)

   ```typescript
   function createTwitterPostTweetTool(): Tool {
     return defineTool({
       name: "twitter_post_tweet",
       description: "Post a tweet to Twitter/X",
       parameters: Schema.Struct({
         content: Schema.String,
         imageUrl: Schema.optional(Schema.String),
         replyTo: Schema.optional(Schema.String),
       }),
       approval: {
         message: (args) => `Post tweet: "${args.content.substring(0, 100)}..."`,
         execute: {
           toolName: "execute_twitter_post_tweet",
           buildArgs: (args) => args,
         },
       },
       handler: (args, context) => {
         // Return approval request
       },
     });
   }
   ```

4. **`linkedin_create_post` Tool** (High Risk - Approval Required)
   ```typescript
   function createLinkedInCreatePostTool(): Tool {
     return defineTool({
       name: "linkedin_create_post",
       description: "Create a post on LinkedIn",
       parameters: Schema.Struct({
         content: Schema.String,
         imageUrl: Schema.optional(Schema.String),
         visibility: Schema.optional(Schema.Literal("public", "connections")),
       }),
       approval: {
         message: (args) => `Post to LinkedIn: "${args.content.substring(0, 100)}..."`,
         execute: {
           toolName: "execute_linkedin_create_post",
           buildArgs: (args) => args,
         },
       },
       handler: (args, context) => {
         // Return approval request
       },
     });
   }
   ```

**Agent Prompt for Social Media Manager:**

The agent would receive a system prompt like:

```
You are a social media manager agent. Your job is to:
1. Generate engaging social media content based on the topic provided
2. Find appropriate images for the content
3. Post to Twitter/X and LinkedIn

When the user provides a topic, use the available tools to:
- Generate content using llm_generate_content
- Search for images using unsplash_search_image
- Post to Twitter using twitter_post_tweet (requires approval)
- Post to LinkedIn using linkedin_create_post (requires approval)

Always ensure content is appropriate and follows platform guidelines.
```

**Scheduling Implementation:**

Would use the scheduled agents system (from exploration doc):

```typescript
// Scheduler service would:
1. Parse cron expression "0 8 * * *"
2. Calculate next run time
3. Execute agent with prompt: "Generate social media post about {{topic}}"
4. Template variables would need to be resolved from environment or context
```

**Challenges:**

1. **Template Variable Resolution**: `{{topic}}`, `{{post}}`, `{{image}}` need to be resolved
   - Could use environment variables
   - Could use conversation context
   - Could use a template engine

2. **State Management**: Need to pass data between tool calls
   - Current: Tool results are in conversation history
   - Solution: Agent can reference previous tool results in prompts

3. **Approval Flow**: Social media posts require approval
   - Current: Approval system exists for tools
   - Solution: Use approval-required tools

4. **API Authentication**: Twitter, LinkedIn, Unsplash APIs need OAuth
   - Solution: Add credential management for third-party services

#### Option B: Task-Based Agent (Not Recommended)

Could theoretically work but loses the flexibility of AI decision-making:

```typescript
const tasks: Task[] = [
  {
    id: "generate-content",
    name: "Generate Social Media Content",
    type: "custom", // Would need custom task executor
    config: {
      llmPrompt: "Generate engaging social media post about {{topic}}",
    },
  },
  {
    id: "search-image",
    name: "Search for Image",
    type: "api",
    config: {
      url: "https://api.unsplash.com/search/photos",
      method: "GET",
      headers: { Authorization: "Client-ID {{UNSPLASH_KEY}}" },
    },
    dependencies: ["generate-content"],
  },
  // ... more tasks
];
```

**Problems:**

- No variable substitution between tasks
- No conditional logic
- Less flexible than AI agent approach

### 2. Blog Content Agent

**Vision Example:**

```bash
jazz agent create --name "blog-writer" --type "ai-agent" \
  --tools "web-scraper,llm,wordpress,seo" \
  --schedule "weekly" \
  --config '{
    "tasks": [
      {"type": "web-scraper", "urls": "{{research_urls}}"},
      {"type": "llm", "prompt": "Write comprehensive blog post about {{topic}}"},
      {"type": "seo", "action": "optimize", "content": "{{blog_post}}"},
      {"type": "wordpress", "action": "publish", "post": "{{optimized_post}}"}
    ]
  }'
```

**Implementation Approach:**

#### Required New Tools:

1. **`web_scrape` Tool**

   ```typescript
   function createWebScrapeTool(): Tool {
     return defineTool({
       name: "web_scrape",
       description: "Scrape content from web pages for research",
       parameters: Schema.Struct({
         urls: Schema.Array(Schema.String),
         extractText: Schema.optional(Schema.Boolean),
         extractLinks: Schema.optional(Schema.Boolean),
       }),
       handler: async (args, context) => {
         // Use HTTP tool or dedicated scraper
         // Return structured content
       },
     });
   }
   ```

2. **`seo_optimize_content` Tool**

   ```typescript
   function createSEOOptimizeContentTool(): Tool {
     return defineTool({
       name: "seo_optimize_content",
       description: "Analyze and optimize content for SEO",
       parameters: Schema.Struct({
         content: Schema.String,
         targetKeywords: Schema.Array(Schema.String),
         checkReadability: Schema.optional(Schema.Boolean),
       }),
       handler: async (args, context) => {
         // Analyze content
         // Check keyword density
         // Check readability
         // Suggest improvements
         // Return optimized content + suggestions
       },
     });
   }
   ```

3. **`wordpress_create_post` Tool** (High Risk - Approval Required)
   ```typescript
   function createWordPressCreatePostTool(): Tool {
     return defineTool({
       name: "wordpress_create_post",
       description: "Create or publish a post on WordPress",
       parameters: Schema.Struct({
         title: Schema.String,
         content: Schema.String,
         status: Schema.optional(Schema.Literal("draft", "publish", "pending")),
         categories: Schema.optional(Schema.Array(Schema.String)),
         tags: Schema.optional(Schema.Array(Schema.String)),
       }),
       approval: {
         message: (args) => `Publish WordPress post: "${args.title}"`,
         execute: {
           toolName: "execute_wordpress_create_post",
           buildArgs: (args) => args,
         },
       },
       handler: (args, context) => {
         // Return approval request
       },
     });
   }
   ```

**Agent Workflow:**

```
User: "Write a blog post about TypeScript best practices"

Agent:
1. Uses web_scrape to research topic (if research_urls provided)
2. Uses llm_generate_content (or direct LLM call) to write blog post
3. Uses seo_optimize_content to optimize the post
4. Uses wordpress_create_post to publish (with approval)
```

**Note:** The `llm` task type in the vision would actually be the agent itself making LLM calls through its normal operation, not a separate task.

### 3. Infrastructure Monitor

**Vision Example:**

```bash
jazz agent create --name "infra-monitor" --type "ai-agent" \
  --tools "prometheus,kubernetes,slack,pagerduty" \
  --schedule "every-5-minutes" \
  --config '{
    "tasks": [
      {"type": "prometheus", "action": "query", "metrics": "cpu_usage,memory_usage"},
      {"type": "llm", "prompt": "Analyze system metrics and identify issues"},
      {"type": "kubernetes", "action": "scale", "when": "high_cpu"},
      {"type": "slack", "message": "System alert: {{alert_message}}"},
      {"type": "pagerduty", "action": "trigger", "when": "critical_issue"}
    ]
  }'
```

**Implementation Approach:**

#### Required New Tools:

1. **`prometheus_query` Tool**

   ```typescript
   function createPrometheusQueryTool(): Tool {
     return defineTool({
       name: "prometheus_query",
       description: "Query Prometheus metrics",
       parameters: Schema.Struct({
         query: Schema.String, // PromQL query
         timeRange: Schema.optional(Schema.String), // e.g., "5m", "1h"
       }),
       handler: async (args, context) => {
         // Query Prometheus API
         // Return metric values
       },
     });
   }
   ```

2. **`kubernetes_scale_deployment` Tool** (Critical Risk - Approval Required)

   ```typescript
   function createKubernetesScaleDeploymentTool(): Tool {
     return defineTool({
       name: "kubernetes_scale_deployment",
       description: "Scale a Kubernetes deployment",
       parameters: Schema.Struct({
         namespace: Schema.String,
         deployment: Schema.String,
         replicas: Schema.Number,
       }),
       approval: {
         message: (args) =>
           `Scale ${args.deployment} in ${args.namespace} to ${args.replicas} replicas`,
         execute: {
           toolName: "execute_kubernetes_scale_deployment",
           buildArgs: (args) => args,
         },
       },
       handler: (args, context) => {
         // Return approval request
       },
     });
   }
   ```

3. **`slack_send_message` Tool**

   ```typescript
   function createSlackSendMessageTool(): Tool {
     return defineTool({
       name: "slack_send_message",
       description: "Send a message to a Slack channel",
       parameters: Schema.Struct({
         channel: Schema.String,
         message: Schema.String,
         threadTs: Schema.optional(Schema.String), // For threading
       }),
       handler: async (args, context) => {
         // Call Slack API
       },
     });
   }
   ```

4. **`pagerduty_trigger_incident` Tool** (High Risk - Approval Required)
   ```typescript
   function createPagerDutyTriggerIncidentTool(): Tool {
     return defineTool({
       name: "pagerduty_trigger_incident",
       description: "Trigger a PagerDuty incident",
       parameters: Schema.Struct({
         title: Schema.String,
         severity: Schema.Literal("critical", "error", "warning", "info"),
         details: Schema.String,
       }),
       approval: {
         message: (args) => `Trigger PagerDuty ${args.severity} incident: ${args.title}`,
         execute: {
           toolName: "execute_pagerduty_trigger_incident",
           buildArgs: (args) => args,
         },
       },
       handler: (args, context) => {
         // Return approval request
       },
     });
   }
   ```

**Conditional Logic Challenge:**

The vision includes `"when": "high_cpu"` which implies conditional execution. In an AI agent, this would be handled by the agent's decision-making:

```
Agent receives metrics from prometheus_query
Agent analyzes metrics using LLM reasoning
Agent decides: "CPU is high, I should scale"
Agent calls kubernetes_scale_deployment
```

The agent's system prompt would include:

```
You are an infrastructure monitoring agent. Your responsibilities:
1. Query Prometheus for system metrics (CPU, memory, disk, etc.)
2. Analyze metrics to identify issues
3. Take corrective actions:
   - If CPU > 80%: Scale up deployment
   - If memory > 90%: Alert and potentially restart
   - If critical issue: Trigger PagerDuty
4. Send alerts to Slack for all issues

Always prioritize safety - get approval for destructive actions.
```

**Scheduling:**

```typescript
schedule: {
  type: "interval",
  value: 300000,  // 5 minutes in milliseconds
  enabled: true,
}
```

### 4. Security Scanner

**Vision Example:**

```bash
jazz agent create --name "security-scanner" --type "ai-agent" \
  --tools "nmap,owasp-zap,llm,jira" \
  --schedule "daily-at-2am" \
  --config '{
    "tasks": [
      {"type": "nmap", "action": "scan", "targets": "{{server_list}}"},
      {"type": "owasp-zap", "action": "scan", "urls": "{{web_apps}}"},
      {"type": "llm", "prompt": "Analyze security scan results and prioritize vulnerabilities"},
      {"type": "jira", "action": "create-tickets", "vulnerabilities": "{{high_priority_issues}}"}
    ]
  }'
```

**Implementation Approach:**

#### Required New Tools:

1. **`nmap_scan` Tool** (High Risk - Approval Required for network scans)

   ```typescript
   function createNmapScanTool(): Tool {
     return defineTool({
       name: "nmap_scan",
       description: "Perform network port scan using nmap",
       parameters: Schema.Struct({
         targets: Schema.Array(Schema.String), // IP addresses or hostnames
         scanType: Schema.optional(Schema.Literal("quick", "full", "stealth")),
         ports: Schema.optional(Schema.String), // e.g., "80,443,8080" or "1-1000"
       }),
       approval: {
         message: (args) => `Perform nmap scan on ${args.targets.length} target(s)`,
         execute: {
           toolName: "execute_nmap_scan",
           buildArgs: (args) => args,
         },
       },
       handler: (args, context) => {
         // Return approval request
       },
     });
   }
   ```

2. **`owasp_zap_scan` Tool** (High Risk - Approval Required)

   ```typescript
   function createOWASPZapScanTool(): Tool {
     return defineTool({
       name: "owasp_zap_scan",
       description: "Perform security scan using OWASP ZAP",
       parameters: Schema.Struct({
         urls: Schema.Array(Schema.String),
         scanType: Schema.optional(Schema.Literal("quick", "full", "passive")),
       }),
       approval: {
         message: (args) => `Perform OWASP ZAP scan on ${args.urls.length} URL(s)`,
         execute: {
           toolName: "execute_owasp_zap_scan",
           buildArgs: (args) => args,
         },
       },
       handler: (args, context) => {
         // Return approval request
       },
     });
   }
   ```

3. **`jira_create_issue` Tool** (Medium Risk - Approval Required)
   ```typescript
   function createJiraCreateIssueTool(): Tool {
     return defineTool({
       name: "jira_create_issue",
       description: "Create a Jira issue",
       parameters: Schema.Struct({
         project: Schema.String,
         summary: Schema.String,
         description: Schema.String,
         issueType: Schema.optional(Schema.Literal("Bug", "Task", "Story")),
         priority: Schema.optional(Schema.Literal("Lowest", "Low", "Medium", "High", "Highest")),
         labels: Schema.optional(Schema.Array(Schema.String)),
       }),
       approval: {
         message: (args) => `Create Jira issue: "${args.summary}"`,
         execute: {
           toolName: "execute_jira_create_issue",
           buildArgs: (args) => args,
         },
       },
       handler: (args, context) => {
         // Return approval request
       },
     });
   }
   ```

**Agent Workflow:**

```
Scheduled execution (daily at 2am):
1. Agent reads server_list and web_apps from environment/config
2. Agent calls nmap_scan for network targets
3. Agent calls owasp_zap_scan for web applications
4. Agent receives scan results
5. Agent uses LLM to analyze and prioritize vulnerabilities
6. Agent creates Jira tickets for high-priority issues
```

**Analysis with LLM:**

The agent would receive scan results and use its reasoning capabilities:

```
System: You are a security analyst agent. Analyze security scan results and:
1. Identify critical vulnerabilities (CVSS > 7.0)
2. Categorize by severity
3. Prioritize based on exploitability and impact
4. Create Jira tickets for actionable items

Scan Results:
[nmap output]
[OWASP ZAP output]

Analyze these results and create appropriate Jira tickets.
```

## Implementation Patterns

### Pattern 1: AI Agent with Tool Orchestration

**Best For:** Most complex workflows where decision-making is needed

**Structure:**

```typescript
{
  agentType: "ai-agent",
  tools: ["tool1", "tool2", "tool3"],
  // No tasks needed - agent decides what to do
}
```

**Pros:**

- Flexible decision-making
- Can handle conditional logic
- Can adapt to unexpected situations
- Natural language understanding

**Cons:**

- Less predictable
- May make mistakes
- Requires good prompts
- Higher token costs

### Pattern 2: Hybrid Approach

**Best For:** Workflows with both structured and unstructured steps

**Structure:**

```typescript
{
  agentType: "ai-agent",
  tools: ["tool1", "tool2"],
  // Agent handles complex decisions
  // Predefined tasks handle routine operations
  tasks: [
    {
      id: "setup",
      type: "command",
      config: { command: "setup-environment.sh" },
    },
  ],
}
```

**Note:** Current architecture doesn't support this - tasks and AI agents are separate. Would need enhancement.

### Pattern 3: Task Orchestration with LLM Tool

**Best For:** When you want more control but still need LLM capabilities

**Structure:**

```typescript
{
  agentType: "ai-agent",
  tools: ["llm_generate_content", "other_tools"],
  // Agent uses llm_generate_content as a tool
  // Other tools for structured operations
}
```

## Key Implementation Challenges

### 1. Template Variable Resolution

**Problem:** Vision examples use `{{variable}}` syntax that doesn't exist.

**Current State:** No template engine

**Solutions:**

**Option A: Environment Variables**

```typescript
environment: {
  TOPIC: "AI automation",
  SERVER_LIST: "server1.com,server2.com",
}
// Agent reads from environment
```

**Option B: Conversation Context**

```typescript
// Agent maintains context in conversation
// Previous tool results are in message history
// Agent can reference them naturally
```

**Option C: Template Engine**

```typescript
// Add template resolution service
function resolveTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return String(context[key] ?? `{{${key}}}`);
  });
}
```

**Recommendation:** Start with Option B (conversation context), add Option C for explicit templates later.

### 2. Conditional Execution

**Problem:** `"when": "high_cpu"` implies conditional logic.

**Current State:** No conditional task execution

**Solutions:**

**Option A: AI Agent Decision-Making** (Recommended)

- Agent analyzes results and decides what to do
- Natural conditional logic through reasoning

**Option B: Task Conditions**

```typescript
{
  id: "scale-up",
  type: "kubernetes",
  condition: {
    metric: "cpu_usage",
    operator: ">",
    value: 80,
  },
  config: { ... },
}
```

**Recommendation:** Use Option A for now, consider Option B for task-based agents.

### 3. State Management Between Tasks

**Problem:** Task results need to be passed to subsequent tasks.

**Current State:** Task results are stored but not easily accessible

**Solutions:**

**Option A: Conversation History** (AI Agents)

- Tool results are in conversation history
- Agent can reference them in prompts

**Option B: Task Result Variables**

```typescript
{
  id: "task2",
  dependencies: ["task1"],
  config: {
    // Reference task1 result
    input: "{{task1.output}}",
  },
}
```

**Recommendation:** Implement Option B for task-based agents, Option A already works for AI agents.

### 4. Third-Party API Integration

**Problem:** Many tools require OAuth/API keys.

**Current State:** Basic credential management exists

**Solutions:**

**Option A: Credential Service**

```typescript
// Add to services
interface CredentialService {
  getCredential(service: string): Effect.Effect<Credentials, Error>;
  storeCredential(service: string, credentials: Credentials): Effect.Effect<void, Error>;
}
```

**Option B: Environment Variables**

```typescript
// User sets TWITTER_API_KEY, LINKEDIN_ACCESS_TOKEN, etc.
// Tools read from environment
```

**Recommendation:** Use Option B initially, build Option A for better UX.

### 5. Scheduling Implementation

**Problem:** `--schedule "daily-at-8am"` needs parsing and execution.

**Current State:** Exploration doc exists, not implemented

**Solutions:**

**Option A: Cron Parser**

```typescript
// Parse natural language to cron
"daily-at-8am" → "0 8 * * *"
"every-5-minutes" → "*/5 * * * *"
"weekly" → "0 0 * * 0"
```

**Option B: Scheduler Service**

```typescript
// Implement from exploration doc
// Use node-cron or similar
// Track execution history
```

**Recommendation:** Implement scheduler service from exploration doc.

## Missing Components

### 1. Tool Implementations

**High Priority:**

- `llm_generate_content` - Wrapper for LLM content generation
- `http_request` - Already exists, but may need enhancements
- `slack_send_message` - Notification tool
- `web_scrape` - Research tool

**Medium Priority:**

- Social media tools (Twitter, LinkedIn, Instagram)
- Image services (Unsplash, image generation)
- CMS tools (WordPress, Notion)
- Monitoring tools (Prometheus, Kubernetes)

**Low Priority:**

- Security tools (nmap, OWASP ZAP) - Require careful security considerations
- SEO tools - Can be built as analysis tools

### 2. Template Engine

For variable substitution in configs and prompts.

### 3. Scheduler Service

For time-based agent execution.

### 4. Credential Management

For third-party API authentication.

### 5. Task Result Variables

For passing data between tasks in task-based agents.

## Implementation Roadmap

### Phase 1: Foundation (2-3 weeks)

1. **Template Engine**
   - Basic `{{variable}}` resolution
   - Support in agent configs and prompts
   - Environment variable integration

2. **Core Tools**
   - `llm_generate_content` tool
   - `web_scrape` tool (using existing HTTP tool)
   - `slack_send_message` tool

3. **Scheduler Service** (MVP)
   - Basic cron parsing
   - Simple scheduler
   - Execution tracking

### Phase 2: Social Media & Content (3-4 weeks)

1. **Social Media Tools**
   - Twitter/X API integration
   - LinkedIn API integration
   - Approval flows for posting

2. **Image Services**
   - Unsplash integration
   - Image download/caching

3. **Content Tools**
   - SEO analysis tool
   - WordPress integration (if needed)

### Phase 3: Infrastructure & Monitoring (3-4 weeks)

1. **Monitoring Tools**
   - Prometheus query tool
   - Kubernetes operations (with approval)
   - PagerDuty integration

2. **Alerting**
   - Slack notifications
   - Email alerts
   - Custom webhooks

### Phase 4: Security & Advanced (4-5 weeks)

1. **Security Tools** (Careful implementation)
   - nmap wrapper (with strong approval)
   - OWASP ZAP integration
   - Security analysis tools

2. **Task Result Variables**
   - Variable passing between tasks
   - Conditional task execution

3. **Advanced Scheduling**
   - Natural language schedule parsing
   - Complex cron expressions
   - Timezone support

## Example: Complete Social Media Manager Implementation

### Step 1: Create Tools

```typescript
// src/core/agent/tools/social-media-tools.ts

export function createTwitterPostTweetTool(): Tool {
  return defineTool({
    name: "twitter_post_tweet",
    description: "Post a tweet to Twitter/X. Requires approval.",
    parameters: Schema.Struct({
      content: Schema.String.pipe(
        Schema.filter((s) => s.length <= 280, {
          message: () => "Tweet content must be 280 characters or less",
        }),
      ),
      imageUrl: Schema.optional(Schema.String),
      replyTo: Schema.optional(Schema.String),
    }),
    tags: ["social-media", "twitter", "high-risk"],
    approval: {
      message: (args) =>
        `Post tweet to Twitter/X:\n\n"${args.content}"\n\n${args.imageUrl ? `With image: ${args.imageUrl}` : ""}`,
      execute: {
        toolName: "execute_twitter_post_tweet",
        buildArgs: (args) => args,
      },
    },
    handler: (args, context) => {
      // Return approval request
      return Effect.succeed({
        success: false,
        result: {
          approvalRequired: true,
          message: `Post tweet: "${args.content.substring(0, 50)}..."`,
        },
        error: "Approval required for Twitter post",
      });
    },
  });
}

export function createExecuteTwitterPostTweetTool(): Tool {
  return defineTool({
    name: "execute_twitter_post_tweet",
    description: "Internal tool for executing approved Twitter posts",
    parameters: Schema.Struct({
      content: Schema.String,
      imageUrl: Schema.optional(Schema.String),
      replyTo: Schema.optional(Schema.String),
    }),
    hidden: true, // Hide from agent tool list
    handler: async (args, context) => {
      // Get Twitter credentials from config
      const config = yield * ConfigService;
      const twitterConfig = yield * config.getServiceConfig("twitter");

      // Call Twitter API v2
      const response =
        yield *
        httpRequest({
          url: "https://api.twitter.com/2/tweets",
          method: "POST",
          headers: {
            Authorization: `Bearer ${twitterConfig.bearerToken}`,
            "Content-Type": "application/json",
          },
          body: {
            text: args.content,
            ...(args.replyTo && { reply: { in_reply_to_tweet_id: args.replyTo } }),
          },
        });

      return {
        success: true,
        result: {
          tweetId: response.data.id,
          url: `https://twitter.com/i/web/status/${response.data.id}`,
        },
      };
    },
  });
}
```

### Step 2: Register Tools

```typescript
// src/core/agent/tools/register-tools.ts

export function registerSocialMediaTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(SOCIAL_MEDIA_CATEGORY);

    yield* registerTool(createTwitterPostTweetTool());
    yield* registerTool(createExecuteTwitterPostTweetTool());
    yield* registerTool(createLinkedInCreatePostTool());
    // ... more tools
  });
}
```

### Step 3: Create Agent

```typescript
// User runs:
// jazz agent create --name "social-manager" --type "ai-agent" \
//   --tools "twitter_post_tweet,linkedin_create_post,llm_generate_content,unsplash_search_image"

const agent =
  yield *
  agentService.createAgent(
    "social-manager",
    "Automatically creates and posts social media content",
    {
      agentType: "ai-agent",
      llmProvider: "openai",
      llmModel: "gpt-4o",
      tools: [
        "llm_generate_content",
        "unsplash_search_image",
        "twitter_post_tweet",
        "linkedin_create_post",
      ],
      schedule: {
        type: "cron",
        value: "0 8 * * *", // Daily at 8am
        enabled: true,
      },
    },
  );
```

### Step 4: Agent System Prompt

The agent would receive a system prompt (from `agent-prompt.ts`):

```
You are a social media manager agent. Your responsibilities:

1. Generate engaging social media content based on topics provided
2. Find appropriate images to accompany posts
3. Post content to Twitter/X and LinkedIn

Guidelines:
- Twitter posts must be 280 characters or less
- LinkedIn posts can be longer but keep them engaging
- Always use appropriate images that match the content
- Follow platform best practices
- Get approval before posting (tools will handle this)

When given a topic, use the available tools to:
1. Generate content using llm_generate_content
2. Search for images using unsplash_search_image
3. Post to Twitter using twitter_post_tweet (requires approval)
4. Post to LinkedIn using linkedin_create_post (requires approval)
```

### Step 5: Scheduled Execution

```typescript
// Scheduler service (from exploration doc)
const scheduler = yield * SchedulerServiceTag;

yield *
  scheduler.createScheduledAgent({
    name: "social-manager-daily",
    agentId: agent.id,
    schedule: {
      type: "cron",
      expression: "0 8 * * *",
    },
    prompt: "Generate a social media post about AI automation trends",
    enabled: true,
  });
```

## Conclusion

The vision examples are **achievable** with Jazz's current architecture, but require:

1. **New Tool Implementations**: Most tools don't exist yet
2. **Template Engine**: For variable substitution
3. **Scheduler Service**: For time-based execution
4. **Credential Management**: For third-party APIs
5. **Approval System**: Already exists, but needs to be used consistently

**Recommended Approach:**

- Use **AI Agents** (not task-based) for these workflows
- Implement tools as **Effect-based tools** in the tool registry
- Use **approval system** for high-risk operations
- Leverage **LLM reasoning** for conditional logic and decision-making
- Build **scheduler service** for automated execution

**Priority Order:**

1. Template engine + core tools (llm_generate_content, web_scrape)
2. Social media tools (highest user value)
3. Scheduler service (enables automation)
4. Monitoring tools (infrastructure use case)
5. Security tools (requires careful consideration)

The architecture is sound - it's primarily a matter of building out the tool ecosystem and supporting services.
