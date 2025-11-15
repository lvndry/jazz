# Tool Approval Policies & Trust Management

## Overview

Tool approval policies enable users to control which tools agents can execute automatically versus
which require explicit confirmation. This balances **automation** (agents working autonomously) with
**safety** (preventing unwanted actions).

The key insight: **Not all tools are equally risky**. Reading a file is safe, deleting files is not.
Users should approve risky actions once, then trust the agent for similar operations.

## The Approval Challenge

**Without approval management:**

```bash
Agent: "I need to read package.json"
User: Approve? [y/n] ▊

Agent: "I need to read tsconfig.json"
User: Approve? [y/n] ▊

Agent: "I need to read README.md"
User: Approve? [y/n] ▊

# This is exhausting! 😤
```

**With smart approval policies:**

```bash
Agent: "I need to read package.json"
User: Approve? [y/n/always for read operations] ▊
User: > always

Agent: "Reading tsconfig.json..." ✅
Agent: "Reading README.md..." ✅
# No more prompts for read operations! 🎉
```

## Core Concepts

### Risk Levels

Every tool is assigned a risk level that determines default approval behavior.

```typescript
export type ToolRiskLevel = "safe" | "low" | "medium" | "high" | "critical";

export interface ToolRiskProfile {
  readonly toolName: string;
  readonly riskLevel: ToolRiskLevel;
  readonly riskFactors: readonly RiskFactor[];
  readonly description: string;
  readonly examples: {
    readonly safe: readonly string[];
    readonly risky: readonly string[];
  };
}

export interface RiskFactor {
  readonly type:
    | "data_modification"
    | "data_deletion"
    | "external_communication"
    | "system_modification"
    | "credential_access"
    | "financial_transaction"
    | "irreversible_action";
  readonly severity: number; // 0-10
  readonly description: string;
}
```

### Risk Level Definitions

**Safe (Auto-approve by default)**

- Read-only operations
- No side effects
- No external communication
- Examples: `read_file`, `list_dir`, `pwd`, `git_status`

**Low (Ask once, remember)**

- Minor modifications
- Reversible actions
- Limited scope
- Examples: `write_file` (non-system paths), `mkdir`, `git_log`

**Medium (Ask with context)**

- Significant changes
- External communication
- Broader scope
- Examples: `send_email`, `http_request`, `git_commit`

**High (Always ask with details)**

- Dangerous operations
- Difficult to reverse
- System-wide impact
- Examples: `delete_file`, `execute_command`, `git_push`

**Critical (Require explicit confirmation + reason)**

- Irreversible actions
- Security implications
- Financial transactions
- Examples: `delete_database`, `deploy_production`, `charge_credit_card`

## Approval Policy Types

```typescript
export type ApprovalPolicy =
  | AlwaysApprovePolicy
  | AlwaysAskPolicy
  | NeverAllowPolicy
  | ConditionalPolicy
  | RiskBasedPolicy;

export interface AlwaysApprovePolicy {
  readonly type: "always_approve";
  readonly scope: PolicyScope;
  readonly grantedAt: Date;
  readonly grantedBy: string;
  readonly expiresAt?: Date;
  readonly conditions?: readonly PolicyCondition[];
}

export interface AlwaysAskPolicy {
  readonly type: "always_ask";
  readonly scope: PolicyScope;
  readonly reason?: string;
}

export interface NeverAllowPolicy {
  readonly type: "never_allow";
  readonly scope: PolicyScope;
  readonly reason: string;
}

export interface ConditionalPolicy {
  readonly type: "conditional";
  readonly scope: PolicyScope;
  readonly conditions: readonly PolicyCondition[];
  readonly action: "approve" | "ask" | "deny";
}

export interface RiskBasedPolicy {
  readonly type: "risk_based";
  readonly maxAutoApproveRisk: ToolRiskLevel;
  readonly customRiskLevels?: Record<string, ToolRiskLevel>;
}

export type PolicyScope =
  | { type: "tool"; toolName: string }
  | { type: "tool_category"; category: string }
  | { type: "risk_level"; level: ToolRiskLevel }
  | { type: "pattern"; pattern: string }; // e.g., "read_*", "git_*"

export interface PolicyCondition {
  readonly type: "path_pattern" | "time_window" | "agent_id" | "argument_match" | "frequency_limit";
  readonly value: unknown;
}
```

## Implementation

### Approval Policy Service

```typescript
import { Context, Effect, Ref } from "effect";

export interface ApprovalPolicyService {
  /**
   * Check if a tool execution should be approved
   */
  readonly checkApproval: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => Effect.Effect<ApprovalDecision, Error>;

  /**
   * Store user's approval decision
   */
  readonly recordApproval: (
    decision: ApprovalDecision,
    remember: ApprovalRememberOption,
  ) => Effect.Effect<void, Error>;

  /**
   * Get policies for a tool
   */
  readonly getPolicies: (toolName: string) => Effect.Effect<readonly ApprovalPolicy[], never>;

  /**
   * Set a policy
   */
  readonly setPolicy: (policy: ApprovalPolicy) => Effect.Effect<void, Error>;

  /**
   * Remove a policy
   */
  readonly removePolicy: (scope: PolicyScope) => Effect.Effect<void, Error>;

  /**
   * List all policies
   */
  readonly listPolicies: () => Effect.Effect<readonly ApprovalPolicy[], never>;

  /**
   * Reset to defaults
   */
  readonly resetToDefaults: () => Effect.Effect<void, Error>;
}

export const ApprovalPolicyServiceTag =
  Context.GenericTag<ApprovalPolicyService>("ApprovalPolicyService");

export interface ApprovalDecision {
  readonly approved: boolean;
  readonly reason: string;
  readonly policy?: ApprovalPolicy;
  readonly requiresUserInput: boolean;
  readonly suggestion?: string;
}

export type ApprovalRememberOption =
  | "once" // Just this time
  | "session" // For this conversation
  | "always" // Forever
  | "tool" // Always for this tool
  | "category" // Always for this category
  | "risk_level"; // Always for this risk level

export class DefaultApprovalPolicyService implements ApprovalPolicyService {
  constructor(
    private readonly policies: Ref.Ref<ApprovalPolicy[]>,
    private readonly riskProfiles: Ref.Ref<Map<string, ToolRiskProfile>>,
    private readonly sessionApprovals: Ref.Ref<Map<string, Set<string>>>, // conversationId -> tool names
  ) {}

  static create(): Effect.Effect<DefaultApprovalPolicyService, never> {
    return Effect.gen(function* () {
      const policies = yield* Ref.make<ApprovalPolicy[]>([]);
      const riskProfiles = yield* Ref.make(new Map<string, ToolRiskProfile>());
      const sessionApprovals = yield* Ref.make(new Map<string, Set<string>>());

      const service = new DefaultApprovalPolicyService(policies, riskProfiles, sessionApprovals);

      // Initialize with default risk profiles
      yield* service.initializeDefaultRiskProfiles();

      return service;
    });
  }

  checkApproval(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Effect.Effect<ApprovalDecision, Error, LoggerService> {
    return Effect.gen(
      function* (this: DefaultApprovalPolicyService) {
        const logger = yield* LoggerServiceTag;

        // 1. Check session approvals (temporary for this conversation)
        const sessionApprovals = yield* Ref.get(this.sessionApprovals);
        const conversationApprovals = sessionApprovals.get(context.conversationId);
        if (conversationApprovals?.has(toolName)) {
          return {
            approved: true,
            reason: "Previously approved for this session",
            requiresUserInput: false,
          };
        }

        // 2. Check explicit policies
        const policies = yield* Ref.get(this.policies);
        const applicablePolicies = policies.filter((policy) =>
          matchesScope(policy.scope, toolName, args),
        );

        // Check for "never allow" first
        const neverPolicy = applicablePolicies.find((p) => p.type === "never_allow");
        if (neverPolicy) {
          return {
            approved: false,
            reason: (neverPolicy as NeverAllowPolicy).reason,
            policy: neverPolicy,
            requiresUserInput: false,
          };
        }

        // Check for "always approve"
        const alwaysPolicy = applicablePolicies.find((p) => p.type === "always_approve");
        if (alwaysPolicy) {
          // Check conditions if any
          const conditionsmet = yield* checkPolicyConditions(
            (alwaysPolicy as AlwaysApprovePolicy).conditions,
            toolName,
            args,
            context,
          );

          if (conditionsmet) {
            return {
              approved: true,
              reason: "Auto-approved by user policy",
              policy: alwaysPolicy,
              requiresUserInput: false,
            };
          }
        }

        // Check conditional policies
        for (const policy of applicablePolicies) {
          if (policy.type === "conditional") {
            const condPolicy = policy as ConditionalPolicy;
            const conditionsMet = yield* checkPolicyConditions(
              condPolicy.conditions,
              toolName,
              args,
              context,
            );

            if (conditionsMet) {
              if (condPolicy.action === "approve") {
                return {
                  approved: true,
                  reason: "Approved by conditional policy",
                  policy: condPolicy,
                  requiresUserInput: false,
                };
              } else if (condPolicy.action === "deny") {
                return {
                  approved: false,
                  reason: "Denied by conditional policy",
                  policy: condPolicy,
                  requiresUserInput: false,
                };
              }
            }
          }
        }

        // 3. Fall back to risk-based approval
        const riskProfiles = yield* Ref.get(this.riskProfiles);
        const riskProfile = riskProfiles.get(toolName);

        if (!riskProfile) {
          yield* logger.warn("No risk profile found for tool", { toolName });
          return {
            approved: false,
            reason: "Unknown tool - approval required",
            requiresUserInput: true,
            suggestion: "This tool has no defined risk level. Please review carefully.",
          };
        }

        // Check if risk level allows auto-approval
        const riskBasedPolicy = applicablePolicies.find((p) => p.type === "risk_based") as
          | RiskBasedPolicy
          | undefined;

        const maxAutoApproveRisk = riskBasedPolicy?.maxAutoApproveRisk || "safe";

        if (isRiskLevelAcceptable(riskProfile.riskLevel, maxAutoApproveRisk)) {
          return {
            approved: true,
            reason: `Auto-approved: ${riskProfile.riskLevel} risk tool`,
            requiresUserInput: false,
          };
        }

        // 4. Requires user approval
        return {
          approved: false,
          reason: `Approval required for ${riskProfile.riskLevel} risk operation`,
          requiresUserInput: true,
          suggestion: buildApprovalSuggestion(toolName, args, riskProfile),
        };
      }.bind(this),
    );
  }

  recordApproval(
    decision: ApprovalDecision,
    remember: ApprovalRememberOption,
  ): Effect.Effect<void, Error> {
    return Effect.gen(
      function* (this: DefaultApprovalPolicyService) {
        switch (remember) {
          case "once":
            // Do nothing - just this execution
            break;

          case "session":
            // Add to session approvals
            // Implementation depends on having conversationId in decision
            break;

          case "always":
          case "tool":
            // Create "always approve" policy for this tool
            const policy: AlwaysApprovePolicy = {
              type: "always_approve",
              scope: { type: "tool", toolName: decision.policy?.scope.toolName || "" },
              grantedAt: new Date(),
              grantedBy: "user",
            };
            yield* this.setPolicy(policy);
            break;

          case "category":
            // Create policy for tool category
            // Would need to determine category from tool
            break;

          case "risk_level":
            // Create policy for risk level
            // Would need risk level from tool
            break;
        }
      }.bind(this),
    );
  }

  setPolicy(policy: ApprovalPolicy): Effect.Effect<void, Error, LoggerService> {
    return Effect.gen(
      function* (this: DefaultApprovalPolicyService) {
        const logger = yield* LoggerServiceTag;

        yield* logger.info("Setting approval policy", {
          type: policy.type,
          scope: policy.scope,
        });

        yield* Ref.update(this.policies, (policies) => {
          // Remove existing policies with same scope
          const filtered = policies.filter((p) => !scopesEqual(p.scope, policy.scope));
          return [...filtered, policy];
        });

        // Persist to storage
        yield* this.persistPolicies();
      }.bind(this),
    );
  }

  private initializeDefaultRiskProfiles(): Effect.Effect<void, never> {
    return Effect.gen(
      function* (this: DefaultApprovalPolicyService) {
        const defaultProfiles: ToolRiskProfile[] = [
          // Safe tools
          {
            toolName: "read_file",
            riskLevel: "safe",
            riskFactors: [],
            description: "Reads a file from the filesystem",
            examples: {
              safe: ["read_file package.json", "read_file README.md"],
              risky: ["read_file ~/.ssh/id_rsa", "read_file /etc/passwd"],
            },
          },
          {
            toolName: "list_dir",
            riskLevel: "safe",
            riskFactors: [],
            description: "Lists directory contents",
            examples: {
              safe: ["list_dir ./src", "list_dir ."],
              risky: [],
            },
          },
          {
            toolName: "pwd",
            riskLevel: "safe",
            riskFactors: [],
            description: "Prints working directory",
            examples: { safe: ["pwd"], risky: [] },
          },

          // Low risk tools
          {
            toolName: "write_file",
            riskLevel: "low",
            riskFactors: [
              {
                type: "data_modification",
                severity: 3,
                description: "Modifies or creates files",
              },
            ],
            description: "Writes content to a file",
            examples: {
              safe: ["write_file ./output.txt", "write_file ./temp.json"],
              risky: ["write_file ~/.bashrc", "write_file /etc/hosts"],
            },
          },
          {
            toolName: "mkdir",
            riskLevel: "low",
            riskFactors: [
              {
                type: "system_modification",
                severity: 2,
                description: "Creates directories",
              },
            ],
            description: "Creates a directory",
            examples: {
              safe: ["mkdir ./build", "mkdir ./tmp"],
              risky: ["mkdir /system"],
            },
          },

          // Medium risk tools
          {
            toolName: "send_email",
            riskLevel: "medium",
            riskFactors: [
              {
                type: "external_communication",
                severity: 5,
                description: "Sends emails to external recipients",
              },
            ],
            description: "Sends an email",
            examples: {
              safe: ["send_email to:self@example.com"],
              risky: ["send_email to:everyone@company.com"],
            },
          },
          {
            toolName: "http_request",
            riskLevel: "medium",
            riskFactors: [
              {
                type: "external_communication",
                severity: 4,
                description: "Makes HTTP requests to external services",
              },
            ],
            description: "Makes an HTTP request",
            examples: {
              safe: ["GET https://api.github.com"],
              risky: ["POST https://api.stripe.com/charges"],
            },
          },

          // High risk tools
          {
            toolName: "execute_command",
            riskLevel: "high",
            riskFactors: [
              {
                type: "system_modification",
                severity: 8,
                description: "Executes arbitrary shell commands",
              },
            ],
            description: "Executes a shell command",
            examples: {
              safe: ["execute_command 'npm test'"],
              risky: ["execute_command 'rm -rf /'", "execute_command 'sudo ...'"],
            },
          },
          {
            toolName: "delete_file",
            riskLevel: "high",
            riskFactors: [
              {
                type: "data_deletion",
                severity: 7,
                description: "Permanently deletes files",
              },
              {
                type: "irreversible_action",
                severity: 8,
                description: "Cannot be undone",
              },
            ],
            description: "Deletes a file",
            examples: {
              safe: ["delete_file ./temp.txt"],
              risky: ["delete_file ~/.ssh/id_rsa", "delete_file ./important-data.db"],
            },
          },
          {
            toolName: "git_push",
            riskLevel: "high",
            riskFactors: [
              {
                type: "external_communication",
                severity: 6,
                description: "Pushes code to remote repository",
              },
              {
                type: "irreversible_action",
                severity: 5,
                description: "Public commits are permanent",
              },
            ],
            description: "Pushes commits to remote",
            examples: {
              safe: ["git_push origin feature-branch"],
              risky: ["git_push --force origin main"],
            },
          },

          // Critical tools
          {
            toolName: "deploy_production",
            riskLevel: "critical",
            riskFactors: [
              {
                type: "system_modification",
                severity: 10,
                description: "Deploys to production environment",
              },
              {
                type: "irreversible_action",
                severity: 9,
                description: "Affects live users",
              },
            ],
            description: "Deploys application to production",
            examples: {
              safe: [],
              risky: ["deploy_production"],
            },
          },
        ];

        yield* Ref.update(this.riskProfiles, (profiles) => {
          const newProfiles = new Map(profiles);
          for (const profile of defaultProfiles) {
            newProfiles.set(profile.toolName, profile);
          }
          return newProfiles;
        });
      }.bind(this),
    );
  }

  private persistPolicies(): Effect.Effect<void, Error, StorageService> {
    return Effect.gen(
      function* (this: DefaultApprovalPolicyService) {
        const storage = yield* StorageServiceTag;
        const policies = yield* Ref.get(this.policies);
        yield* storage.saveApprovalPolicies(policies);
      }.bind(this),
    );
  }

  // ... other methods
}

function matchesScope(
  scope: PolicyScope,
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  switch (scope.type) {
    case "tool":
      return scope.toolName === toolName;
    case "pattern":
      return new RegExp(scope.pattern).test(toolName);
    case "tool_category":
      return getToolCategory(toolName) === scope.category;
    case "risk_level":
      // Would need to check tool's risk level
      return false;
  }
}

function checkPolicyConditions(
  conditions: readonly PolicyCondition[] | undefined,
  toolName: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Effect.Effect<boolean, never> {
  if (!conditions || conditions.length === 0) {
    return Effect.succeed(true);
  }

  return Effect.gen(function* () {
    for (const condition of conditions) {
      const met = yield* checkCondition(condition, toolName, args, context);
      if (!met) return false;
    }
    return true;
  });
}

function checkCondition(
  condition: PolicyCondition,
  toolName: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Effect.Effect<boolean, never> {
  return Effect.sync(() => {
    switch (condition.type) {
      case "path_pattern":
        // Check if file path matches pattern
        const path = args.path as string;
        const pattern = condition.value as string;
        return new RegExp(pattern).test(path);

      case "agent_id":
        return context.agentId === condition.value;

      case "argument_match":
        // Check if specific arguments match
        const argConditions = condition.value as Record<string, unknown>;
        return Object.entries(argConditions).every(([key, value]) => args[key] === value);

      // ... other conditions

      default:
        return true;
    }
  });
}

function isRiskLevelAcceptable(toolRisk: ToolRiskLevel, maxAcceptable: ToolRiskLevel): boolean {
  const riskOrder: ToolRiskLevel[] = ["safe", "low", "medium", "high", "critical"];
  return riskOrder.indexOf(toolRisk) <= riskOrder.indexOf(maxAcceptable);
}

function buildApprovalSuggestion(
  toolName: string,
  args: Record<string, unknown>,
  riskProfile: ToolRiskProfile,
): string {
  const riskFactors = riskProfile.riskFactors.map((f) => `• ${f.description}`).join("\n");

  return `
Tool: ${toolName}
Risk: ${riskProfile.riskLevel}

Risk factors:
${riskFactors}

Arguments:
${JSON.stringify(args, null, 2)}

You can approve this:
- Once (just this time)
- For this session
- Always for this tool
- Always for ${riskProfile.riskLevel} risk tools
`;
}
```

## User Experience

### Interactive Approval Prompts

```typescript
// src/cli/approval-prompt.ts

export async function promptForApproval(
  toolName: string,
  args: Record<string, unknown>,
  decision: ApprovalDecision,
): Promise<{ approved: boolean; remember: ApprovalRememberOption }> {
  console.log(`\n⚠️  Approval Required\n`);
  console.log(`Tool: ${toolName}`);
  console.log(`Action: ${decision.reason}\n`);

  if (decision.suggestion) {
    console.log(decision.suggestion);
  }

  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: "What would you like to do?",
      choices: [
        { name: "✅ Approve (just this once)", value: "approve_once" },
        { name: "✅ Approve for this session", value: "approve_session" },
        { name: "✅ Always approve this tool", value: "approve_always" },
        { name: "❌ Deny (just this once)", value: "deny_once" },
        { name: "🚫 Never allow this tool", value: "deny_always" },
        { name: "ℹ️  Show details", value: "details" },
      ],
    },
  ]);

  if (action === "details") {
    showToolDetails(toolName, args);
    return promptForApproval(toolName, args, decision);
  }

  const approved = action.startsWith("approve");
  const remember = mapActionToRemember(action);

  return { approved, remember };
}
```

### CLI for Managing Policies

```bash
# List all approval policies
$ jazz approval list

📋 Approval Policies:
┌────────────────────┬──────────────┬────────────────┬─────────────┐
│ Tool/Pattern       │ Policy       │ Risk Level     │ Set On      │
├────────────────────┼──────────────┼────────────────┼─────────────┤
│ read_file          │ Auto-approve │ safe           │ Default     │
│ write_file         │ Auto-approve │ low            │ 2024-01-15  │
│ send_email         │ Always ask   │ medium         │ 2024-01-10  │
│ delete_*           │ Never allow  │ high           │ 2024-01-12  │
│ git_push --force   │ Never allow  │ critical       │ User set    │
└────────────────────┴──────────────┴────────────────┴─────────────┘

# Set a policy
$ jazz approval set write_file --policy always
✅ Set policy: Always approve 'write_file'

$ jazz approval set "delete_*" --policy never
✅ Set policy: Never allow tools matching 'delete_*'

# Set conditional policy
$ jazz approval set write_file --policy conditional \
  --condition "path=./output/*" \
  --action approve
✅ Set policy: Auto-approve write_file for paths matching ./output/*

# Remove a policy
$ jazz approval remove write_file
✅ Removed approval policy for 'write_file'

# Set risk-based policy
$ jazz approval set-risk-level medium
✅ Auto-approve all tools up to 'medium' risk

# View tool risk profile
$ jazz approval info execute_command

Tool: execute_command
Risk Level: high ⚠️

Risk Factors:
• System modification (severity: 8/10)
  Executes arbitrary shell commands

Examples:
  Safe: npm test, ls -la
  Risky: rm -rf /, sudo commands

Current Policy: Always ask
```

### Config File Support

```yaml
# ~/.jazz/config.yaml
approval_policies:
  # Risk-based defaults
  max_auto_approve_risk: low

  # Tool-specific policies
  tools:
    read_file:
      policy: always_approve
    write_file:
      policy: always_approve
      conditions:
        - type: path_pattern
          value: "^(?!/).+" # Not absolute paths
    delete_file:
      policy: never_allow
      reason: "Too risky, use trash instead"
    send_email:
      policy: conditional
      conditions:
        - type: argument_match
          value:
            to: "me@example.com"
      action: approve

  # Pattern-based policies
  patterns:
    "git_*":
      policy: always_ask
    "read_*":
      policy: always_approve
    "execute_*":
      policy: always_ask

  # Category-based
  categories:
    filesystem_read:
      policy: always_approve
    filesystem_write:
      policy: always_ask
    network:
      policy: always_ask
```

## Advanced Features

### Temporary Elevation

```typescript
// Temporarily allow higher-risk operations for a session
export interface TemporaryElevation {
  readonly sessionId: string;
  readonly elevatedRiskLevel: ToolRiskLevel;
  readonly grantedAt: Date;
  readonly expiresAt: Date;
  readonly reason: string;
}

// Usage
$ jazz approval elevate --session conv-123 --risk high --duration 1h
⚡ Elevated approval level to 'high' for 1 hour
```

### Audit Log

```typescript
export interface ApprovalAuditEntry {
  readonly id: string;
  readonly timestamp: Date;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly decision: "approved" | "denied";
  readonly method: "auto" | "user" | "policy";
  readonly policyId?: string;
  readonly userId?: string;
  readonly agentId: string;
  readonly conversationId: string;
}

// View audit log
$ jazz approval audit --limit 10

📜 Approval Audit Log:
2024-01-15 10:30:15 | ✅ read_file | Auto (risk: safe)
2024-01-15 10:30:20 | ✅ write_file | Auto (policy: always_approve)
2024-01-15 10:31:05 | ❌ delete_file | Denied (policy: never_allow)
2024-01-15 10:32:10 | ✅ send_email | User approved (session)
```

### Smart Recommendations

```typescript
// Learn from user patterns and suggest policy updates
export interface PolicyRecommendation {
  readonly toolName: string;
  readonly currentPolicy: ApprovalPolicy | null;
  readonly recommendedPolicy: ApprovalPolicy;
  readonly reason: string;
  readonly confidence: number;
  readonly basedOn: {
    readonly totalInvocations: number;
    readonly userApprovals: number;
    readonly userDenials: number;
    readonly lastUsed: Date;
  };
}

// Example
$ jazz approval recommendations

💡 Policy Recommendations:

1. write_file
   Current: Always ask
   Recommended: Auto-approve (conditions: path=./src/*)
   Reason: You've approved write_file 20 times for paths in ./src/
   Confidence: 95%

   Apply? [y/n] ▊
```

### Context-Aware Policies

```typescript
// Different policies based on context
export interface ContextualPolicy extends ApprovalPolicy {
  readonly contexts: readonly PolicyContext[];
}

export interface PolicyContext {
  readonly type: "time_of_day" | "day_of_week" | "agent_id" | "user_id" | "location";
  readonly value: unknown;
}

// Example: More permissive during work hours
{
  type: "conditional",
  scope: { type: "risk_level", level: "medium" },
  conditions: [
    {
      type: "time_window",
      value: {
        start: "09:00",
        end: "18:00",
        timezone: "America/New_York"
      }
    }
  ],
  action: "approve"
}
```

## Security Considerations

### Privilege Escalation Prevention

```typescript
// Prevent agents from changing their own approval policies
export interface PolicyConstraint {
  readonly cannotModifyPoliciesFor: readonly string[]; // Tool names
  readonly requiresHumanApproval: readonly ToolRiskLevel[];
  readonly maxElevationLevel: ToolRiskLevel;
}
```

### Sandboxing Integration

```typescript
// Combine with sandboxing for defense in depth
export interface SandboxedToolExecution {
  readonly sandbox: "none" | "restricted" | "strict";
  readonly allowedPaths: readonly string[];
  readonly allowedNetwork: readonly string[];
  readonly resourceLimits: {
    readonly maxMemory: number;
    readonly maxCpu: number;
    readonly timeout: number;
  };
}
```

## Implementation Roadmap

### Phase 1: Core Approval System (Week 1-2)

- [ ] Risk level definitions
- [ ] Approval decision logic
- [ ] Basic policies (always, never, ask)
- [ ] CLI prompts for approval
- [ ] Policy storage (file-based)

### Phase 2: Policy Management (Week 3)

- [ ] CLI commands for policies
- [ ] Config file support
- [ ] Session-based approvals
- [ ] Policy persistence

### Phase 3: Smart Features (Week 4)

- [ ] Conditional policies
- [ ] Pattern matching
- [ ] Audit logging
- [ ] Policy recommendations

### Phase 4: Advanced (Week 5+)

- [ ] Temporary elevation
- [ ] Context-aware policies
- [ ] Risk profile customization
- [ ] Policy analytics dashboard

## Summary

Tool approval policies transform Jazz from "always asking" to "intelligently trusting" agents. Key
benefits:

1. **Reduced Friction**: Approve once, trust forever for safe operations
2. **Safety**: Never worry about dangerous operations
3. **Flexibility**: Fine-grained control per tool, pattern, or risk level
4. **Learning**: System learns from your preferences
5. **Auditability**: Full log of what was approved and why

The sweet spot: **"Safe by default, permissive by choice"** 🎯
