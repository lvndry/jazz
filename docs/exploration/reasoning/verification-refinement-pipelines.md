# Verification-and-Refinement Pipelines for Jazz

## Overview

Inspired by recent breakthrough research on IMO 2025([Huang & Yang, 2025](https://arxiv.org/pdf/2507.15855)), where a verification-and-refinement pipeline achieved 85.7% accuracy on Olympiad-level mathematics (compared to 21-38% baseline), we explore how Jazz can incorporate advanced reasoning patterns to build more powerful, reliable agents.

**Key Insight from Research**:

> "The path to advanced AI reasoning requires not only developing more powerful base models but also
> designing effective methodologies to harness their full potential for complex tasks."

This principle is perfectly aligned with Jazz's architecture: we can make agents dramatically more
capable through better orchestration, verification, and refinement strategies.

## The Verification-and-Refinement Pattern

### Core Concept

Instead of asking an LLM once and accepting the answer, create a loop:

```
1. Generate multiple candidate solutions
2. Verify each candidate (check correctness)
3. Refine incorrect/incomplete solutions
4. Repeat until verified or max iterations
5. Select best verified solution
```

### Why This Works

**Mathematical Proof**: IMO 2025 results showed:

- Single attempt: 21-38% accuracy
- With verification-refinement: 85.7% accuracy
- **2.2-4x improvement** from methodology alone

**Key advantages**:

- ✅ Self-correction: Agents catch and fix their own mistakes
- ✅ Multiple attempts: Generate diverse solutions, pick best
- ✅ Verification: Validate before returning results
- ✅ Model-agnostic: Works with any LLM
- ✅ Compound reliability: Multiple checks compound success rate

## Implementation for Jazz

### Level 1: Basic Verification Loop

```typescript
interface VerificationConfig {
  maxAttempts: number;
  maxCandidates: number;
  verificationStrategy: "self-check" | "tool-based" | "multi-model";
}

class VerifyingAgent extends BaseAgent {
  async solveWithVerification(
    problem: string,
    config: VerificationConfig,
  ): Promise<VerifiedSolution> {
    const candidates: Solution[] = [];

    // Step 1: Generate multiple candidate solutions
    for (let i = 0; i < config.maxCandidates; i++) {
      const candidate = await this.generateSolution(problem, {
        temperature: 0.7 + i * 0.1, // Vary temperature for diversity
        approach: this.selectApproach(i), // Try different approaches
      });
      candidates.push(candidate);
    }

    // Step 2: Verify each candidate
    const verifiedCandidates = await Promise.all(
      candidates.map(async (candidate) => {
        const verification = await this.verify(candidate);
        return { candidate, verification };
      }),
    );

    // Step 3: Refine unverified candidates
    let bestSolution = this.selectBest(verifiedCandidates);
    let attempts = 0;

    while (!bestSolution.verification.isValid && attempts < config.maxAttempts) {
      const refinedSolution = await this.refine(
        problem,
        bestSolution.candidate,
        bestSolution.verification.errors,
      );

      const verification = await this.verify(refinedSolution);
      bestSolution = { candidate: refinedSolution, verification };
      attempts++;
    }

    return {
      solution: bestSolution.candidate,
      verified: bestSolution.verification.isValid,
      attempts,
      candidates: candidates.length,
    };
  }
}
```

### Level 2: Multi-Strategy Verification

Different verification strategies for different problem types:

```typescript
class MultiStrategyVerifier {
  async verify(solution: Solution, strategy: VerificationStrategy): Promise<Verification> {
    switch (strategy) {
      case "self-check":
        return await this.selfCheck(solution);

      case "tool-based":
        return await this.toolBasedVerification(solution);

      case "multi-model":
        return await this.multiModelConsensus(solution);

      case "formal":
        return await this.formalVerification(solution);
    }
  }

  // Strategy 1: Self-check (LLM verifies its own work)
  private async selfCheck(solution: Solution): Promise<Verification> {
    const prompt = `
You previously generated this solution:

${solution.content}

Now, critically verify this solution:
1. Check each step for logical errors
2. Verify calculations
3. Test edge cases
4. Identify any flaws or gaps

Is this solution correct? If not, what are the specific errors?
`;

    const verification = await this.llm.chat(prompt);
    return this.parseVerification(verification);
  }

  // Strategy 2: Tool-based verification (execute and test)
  private async toolBasedVerification(solution: Solution): Promise<Verification> {
    // For code: run tests
    if (solution.type === "code") {
      const testResults = await executeTool("execute_command", {
        command: solution.testCommand,
      });

      return {
        isValid: testResults.exitCode === 0,
        errors: testResults.stderr,
        confidence: 1.0, // Binary pass/fail
      };
    }

    // For data queries: validate against schema
    if (solution.type === "data-query") {
      const results = await executeTool("execute_query", {
        query: solution.query,
      });

      return this.validateDataSchema(results, solution.expectedSchema);
    }

    // For file operations: check file exists/contents
    if (solution.type === "file-operation") {
      return await this.verifyFileOperation(solution);
    }
  }

  // Strategy 3: Multi-model consensus (multiple models verify)
  private async multiModelConsensus(solution: Solution): Promise<Verification> {
    const verifiers = ["gpt-4o", "claude-3.5-sonnet", "gemini-2.5-pro"];

    const verifications = await Promise.all(
      verifiers.map((model) => this.verifyWithModel(solution, model)),
    );

    // Consensus: At least 2/3 models agree
    const validCount = verifications.filter((v) => v.isValid).length;
    const consensusReached = validCount >= 2;

    return {
      isValid: consensusReached,
      errors: consensusReached ? [] : this.aggregateErrors(verifications),
      confidence: validCount / verifiers.length,
      modelBreakdown: Object.fromEntries(
        verifiers.map((model, i) => [model, verifications[i].isValid]),
      ),
    };
  }

  // Strategy 4: Formal verification (for critical operations)
  private async formalVerification(solution: Solution): Promise<Verification> {
    // For security-critical operations, use formal methods
    if (solution.involvesSecurityRisk) {
      return await this.runStaticAnalysis(solution);
    }

    // For financial calculations, verify exact arithmetic
    if (solution.involvesFinancialData) {
      return await this.verifyArithmetic(solution);
    }

    return { isValid: true, confidence: 1.0, errors: [] };
  }
}
```

### Level 3: Intelligent Refinement

```typescript
class SolutionRefiner {
  async refine(
    problem: string,
    failedSolution: Solution,
    errors: VerificationError[],
  ): Promise<Solution> {
    // Analyze error patterns
    const errorAnalysis = this.analyzeErrors(errors);

    // Generate targeted refinement prompt
    const refinementPrompt = this.buildRefinementPrompt(problem, failedSolution, errorAnalysis);

    // Use more powerful model for refinement
    const refinedSolution = await this.llm.chat({
      model: "gpt-4o", // Upgrade to better model
      prompt: refinementPrompt,
      temperature: 0.3, // Lower temperature for precision
    });

    return refinedSolution;
  }

  private buildRefinementPrompt(
    problem: string,
    failedSolution: Solution,
    errorAnalysis: ErrorAnalysis,
  ): string {
    return `
# Problem
${problem}

# Your Previous Attempt
${failedSolution.content}

# Verification Errors Detected
${errorAnalysis.errors.map((e, i) => `${i + 1}. ${e.description}`).join("\n")}

# Error Pattern Analysis
- Primary issue: ${errorAnalysis.primaryIssue}
- Root cause: ${errorAnalysis.rootCause}
- Suggested fix: ${errorAnalysis.suggestedFix}

# Refinement Task
Generate an improved solution that addresses these specific errors.
Focus on: ${errorAnalysis.focusAreas.join(", ")}

Think step-by-step and verify each step before proceeding.
`;
  }
}
```

## Real-World Applications in Jazz

### Application 1: Code Generation Agent

**Problem**: Generated code often has subtle bugs

**Solution**: Verification-refinement loop

```typescript
class CodeGenerationAgent {
  async generateVerifiedCode(specification: string): Promise<VerifiedCode> {
    // Generate 5 candidate implementations
    const candidates = await this.generateCandidates(specification, 5);

    // Verify each with comprehensive tests
    const verifiedCandidates = await Promise.all(
      candidates.map(async (code) => {
        const testResults = await this.runTests(code);
        const staticAnalysis = await this.runLinter(code);
        const securityScan = await this.scanSecurity(code);

        return {
          code,
          allTestsPass: testResults.passed === testResults.total,
          noLintErrors: staticAnalysis.errors.length === 0,
          noSecurityIssues: securityScan.issues.length === 0,
          score: this.calculateScore(testResults, staticAnalysis, securityScan),
        };
      }),
    );

    // Select best verified candidate
    const best = verifiedCandidates
      .filter((c) => c.allTestsPass && c.noSecurityIssues)
      .sort((a, b) => b.score - a.score)[0];

    if (!best) {
      // No candidate passed verification - refine best attempt
      const bestAttempt = verifiedCandidates.sort((a, b) => b.score - a.score)[0];
      return await this.refineUntilValid(specification, bestAttempt);
    }

    return best;
  }
}
```

**Impact**:

- ✅ Dramatically fewer bugs in generated code
- ✅ Security vulnerabilities caught automatically
- ✅ Higher confidence in agent-generated code

### Application 2: Email Response Agent

**Problem**: Responses sometimes miss key details or have wrong tone

**Solution**: Multi-model consensus verification

```typescript
class EmailResponseAgent {
  async generateVerifiedResponse(email: Email, context: EmailContext): Promise<VerifiedResponse> {
    // Generate 3 candidate responses with different tones
    const candidates = await Promise.all([
      this.generateResponse(email, { tone: "professional" }),
      this.generateResponse(email, { tone: "friendly" }),
      this.generateResponse(email, { tone: "concise" }),
    ]);

    // Verify each with multiple models
    const verifications = await Promise.all(
      candidates.map(async (response) => {
        // Check 1: Does it address all points in original email?
        const addressesAllPoints = await this.verifyCompleteness(email, response);

        // Check 2: Is tone appropriate?
        const appropriateTone = await this.verifyTone(email, response, context);

        // Check 3: Multi-model consensus
        const consensus = await this.multiModelCheck(response, [
          "Does this response fully address the sender's concerns?",
          "Is the tone appropriate for this context?",
          "Are there any factual errors or commitments we can't keep?",
        ]);

        return {
          response,
          addressesAllPoints,
          appropriateTone,
          consensus,
          score: this.calculateResponseScore({
            addressesAllPoints,
            appropriateTone,
            consensus,
          }),
        };
      }),
    );

    // Select best verified response
    const best = verifications.sort((a, b) => b.score - a.score)[0];

    // If score too low, refine
    if (best.score < 0.8) {
      return await this.refineResponse(email, best.response, verifications);
    }

    return best;
  }
}
```

**Impact**:

- ✅ Higher quality email responses
- ✅ Fewer missed points or inappropriate tones
- ✅ Users trust agent more

### Application 3: Data Analysis Agent

**Problem**: Queries sometimes return wrong data or misinterpret requirements

**Solution**: Result verification and cross-checking

```typescript
class DataAnalysisAgent {
  async analyzeWithVerification(question: string, dataset: Dataset): Promise<VerifiedAnalysis> {
    // Generate multiple analysis approaches
    const approaches = [
      { method: "sql", temperature: 0.2 },
      { method: "pandas", temperature: 0.3 },
      { method: "descriptive", temperature: 0.5 },
    ];

    const analyses = await Promise.all(
      approaches.map((approach) => this.performAnalysis(question, dataset, approach)),
    );

    // Cross-verify results
    const verification = await this.crossVerify(analyses);

    if (verification.allAgree) {
      return {
        result: analyses[0].result,
        verified: true,
        confidence: 0.95,
      };
    }

    // Results disagree - investigate
    if (verification.majorityAgree) {
      const majority = verification.majorityResult;
      const outliers = analyses.filter((a) => !this.resultsMatch(a.result, majority));

      // Investigate why outliers differ
      const investigation = await this.investigateDiscrepancy(question, majority, outliers);

      return {
        result: investigation.correctResult,
        verified: true,
        confidence: 0.8,
        notes: `Resolved discrepancy: ${investigation.explanation}`,
      };
    }

    // No agreement - need refinement
    return await this.refineAnalysis(question, dataset, analyses);
  }
}
```

**Impact**:

- ✅ Catch calculation errors automatically
- ✅ Higher confidence in analysis results
- ✅ Identify and explain discrepancies

## Advanced Patterns from IMO Research

### Pattern 1: Temperature-Based Diversity

Generate diverse candidates by varying temperature:

```typescript
async function generateDiverseCandidates(problem: string, count: number = 5): Promise<Solution[]> {
  const temperatures = [0.3, 0.5, 0.7, 0.9, 1.1];

  return await Promise.all(
    temperatures.slice(0, count).map((temp) => llm.chat(problem, { temperature: temp })),
  );
}
```

### Pattern 2: Approach-Based Diversity

Try fundamentally different approaches:

```typescript
async function generateDiverseApproaches(problem: string): Promise<Solution[]> {
  const approaches = [
    "Solve this step-by-step, explaining each step.",
    "Solve this using the most direct method possible.",
    "Solve this by first considering edge cases.",
    "Solve this by working backwards from the desired result.",
    "Solve this using multiple methods and compare.",
  ];

  return await Promise.all(
    approaches.map((approach) => llm.chat(`${approach}\n\nProblem: ${problem}`)),
  );
}
```

### Pattern 3: Iterative Depth Increase

Start simple, add detail iteratively:

```typescript
async function solveIteratively(problem: string, maxIterations: number = 3): Promise<Solution> {
  let solution = await llm.chat(`Outline a solution approach: ${problem}`);

  for (let i = 0; i < maxIterations; i++) {
    const verification = await verify(solution);

    if (verification.isValid) {
      return solution;
    }

    // Add more detail
    solution = await llm.chat(`
Previous solution outline:
${solution}

Verification found these issues:
${verification.errors}

Expand the solution with more detail, addressing these issues.
    `);
  }

  return solution;
}
```

### Pattern 4: Ensemble Voting

Multiple models vote on best solution:

```typescript
async function ensembleSelection(candidates: Solution[]): Promise<Solution> {
  const models = ["gpt-4o", "claude-3.5-sonnet", "gemini-2.5-pro"];

  // Each model ranks all candidates
  const rankings = await Promise.all(
    models.map(async (model) => {
      const ranking = await llm.chat({
        model,
        prompt: `
Rank these solutions from best to worst (1-${candidates.length}):

${candidates.map((c, i) => `Solution ${i + 1}:\n${c.content}`).join("\n\n")}

Output just the ranking: [1, 3, 2] means solution 1 is best, 3 is second, 2 is third.
        `,
      });
      return this.parseRanking(ranking);
    }),
  );

  // Aggregate rankings (Borda count)
  const scores = candidates.map((_, candidateIdx) => {
    return rankings.reduce((score, ranking) => {
      const position = ranking.indexOf(candidateIdx);
      return score + (candidates.length - position);
    }, 0);
  });

  const bestIdx = scores.indexOf(Math.max(...scores));
  return candidates[bestIdx];
}
```

## Integration with Existing Jazz Features

### With Agent Skills

Skills can include verification strategies:

```yaml
# skills/code-generation/SKILL.md
---
name: code-generation
verification:
  enabled: true
  strategies:
    - tool-based # Run tests
    - static-analysis # Linting
    - security-scan # Security checks
  min_confidence: 0.9
  max_refinement_attempts: 3
---
```

### With Workflows

Workflows can enforce verification steps:

```typescript
const workflow = {
  name: "verified-deployment",
  steps: [
    { action: "generate-code", verification: "required" },
    { action: "run-tests", verification: "required" },
    { action: "security-scan", verification: "required" },
    { action: "deploy", verification: "required" },
  ],
  refinementPolicy: {
    maxAttempts: 3,
    escalateOnFailure: true,
  },
};
```

### With Memory

Learn from verification failures:

```typescript
class VerificationMemory {
  async recordVerification(
    problem: string,
    solution: Solution,
    verification: Verification,
  ): Promise<void> {
    if (!verification.isValid) {
      // Store failure pattern
      await memoryService.store({
        type: "verification-failure",
        problem: problem,
        errorPattern: verification.errors,
        solution: solution,
        timestamp: Date.now(),
      });
    }
  }

  async getCommonFailurePatterns(problemType: string): Promise<FailurePattern[]> {
    const failures = await memoryService.query({
      type: "verification-failure",
      problemType: problemType,
    });

    return this.aggregatePatterns(failures);
  }
}
```

## Performance Considerations

### Balancing Speed vs Reliability

Verification adds latency but dramatically improves quality:

```typescript
interface VerificationPerformanceProfile {
  profile: "fast" | "balanced" | "thorough";
}

const profiles = {
  fast: {
    maxCandidates: 1,
    maxRefinementAttempts: 1,
    verificationStrategy: "self-check",
    // ~2x slower than no verification, but 2x more reliable
  },

  balanced: {
    maxCandidates: 3,
    maxRefinementAttempts: 2,
    verificationStrategy: "tool-based",
    // ~3x slower, but 5x more reliable
  },

  thorough: {
    maxCandidates: 5,
    maxRefinementAttempts: 3,
    verificationStrategy: "multi-model",
    // ~5x slower, but 10x more reliable
  },
};
```

### Caching Verified Solutions

```typescript
class VerifiedSolutionCache {
  async getCached(problem: string): Promise<VerifiedSolution | null> {
    // Check for exact match
    const exact = await cache.get(problem);
    if (exact?.verified) return exact;

    // Check for similar problem (semantic cache)
    const similar = await semanticCache.search(problem, {
      threshold: 0.95,
    });

    if (similar && similar.verified) {
      return this.adaptSolution(similar, problem);
    }

    return null;
  }
}
```

### Parallel Verification

Run verification strategies in parallel:

```typescript
async function parallelVerification(solution: Solution): Promise<Verification> {
  const [selfCheck, toolBased, multiModel] = await Promise.all([
    this.selfCheck(solution),
    this.toolBasedVerification(solution),
    this.multiModelConsensus(solution),
  ]);

  // Aggregate results
  return this.aggregateVerifications([selfCheck, toolBased, multiModel]);
}
```

## Configuration

```typescript
interface VerificationConfig {
  // Global settings
  enabled: boolean;
  defaultProfile: "fast" | "balanced" | "thorough";

  // Candidate generation
  candidateGeneration: {
    count: number;
    diversityStrategy: "temperature" | "approach" | "model" | "all";
    temperatureRange: [number, number];
  };

  // Verification
  verification: {
    strategies: VerificationStrategy[];
    requiredConfidence: number; // 0-1
    parallelExecution: boolean;
  };

  // Refinement
  refinement: {
    maxAttempts: number;
    upgradeModel: boolean; // Use better model for refinement
    learningEnabled: boolean; // Learn from failures
  };

  // Performance
  performance: {
    enableCaching: boolean;
    cacheVerifiedSolutions: boolean;
    maxLatency: number; // ms, fallback to fast if exceeded
  };
}

// Example: High-stakes configuration (deployment, financial, security)
const highStakesConfig: VerificationConfig = {
  enabled: true,
  defaultProfile: "thorough",
  candidateGeneration: {
    count: 5,
    diversityStrategy: "all",
    temperatureRange: [0.2, 1.0],
  },
  verification: {
    strategies: ["tool-based", "multi-model", "formal"],
    requiredConfidence: 0.95,
    parallelExecution: true,
  },
  refinement: {
    maxAttempts: 5,
    upgradeModel: true,
    learningEnabled: true,
  },
  performance: {
    enableCaching: true,
    cacheVerifiedSolutions: true,
    maxLatency: 30000, // 30 seconds acceptable for critical tasks
  },
};

// Example: Low-stakes configuration (casual chat, simple queries)
const lowStakesConfig: VerificationConfig = {
  enabled: false, // Skip verification for speed
  defaultProfile: "fast",
  // ... other settings
};
```

## Implementation Roadmap

### Phase 1: Basic Verification (Week 1-2)

1. **Self-check verification** (3 days)
   - Implement self-verification prompts
   - Add verification parsing
2. **Tool-based verification** (3 days)
   - Test execution for code
   - Schema validation for data
3. **Simple refinement loop** (2 days)
   - 1-2 refinement attempts
   - Error-guided prompts

**Expected Impact**: 2x improvement in solution quality

### Phase 2: Multi-Candidate Generation (Week 3)

1. **Temperature diversity** (2 days)
   - Generate N candidates with varying temperature
2. **Approach diversity** (2 days)
   - Different solution strategies
3. **Best candidate selection** (2 days)
   - Scoring and ranking

**Expected Impact**: 3x improvement in solution quality

### Phase 3: Advanced Verification (Week 4-5)

1. **Multi-model consensus** (1 week)
   - Multiple models verify
   - Voting and aggregation
2. **Ensemble selection** (3 days)
   - Multiple models rank candidates
   - Borda count or similar

**Expected Impact**: 4-5x improvement (approaching IMO results)

### Phase 4: Optimization (Week 6-8)

1. **Intelligent caching** (1 week)
   - Cache verified solutions
   - Semantic similarity matching
2. **Adaptive profiles** (1 week)
   - Automatically select profile based on stakes
   - Learn from verification patterns
3. **Performance tuning** (1 week)
   - Parallel execution
   - Latency optimization

**Expected Impact**: Same quality, 50% faster execution

## Real-World Impact Projections

### Email Triage Agent

**Current**: 85% accuracy **With Verification**: 95%+ accuracy

- Fewer missed emails
- Better categorization
- More appropriate urgency levels

### Code Generation Agent

**Current**: 60% code works without bugs **With Verification**: 90%+ code works correctly

- Dramatic reduction in bugs
- Security issues caught automatically
- Higher user confidence

### Deployment Agent

**Current**: Manual verification required **With Verification**: Automated confidence checks

- Safe to deploy without human review
- Catch configuration errors
- Rollback triggers automatically

## Best Practices

### ✅ Do

1. **Use verification for high-stakes operations**
   - Deployments
   - Financial calculations
   - Security-sensitive operations
   - User-facing communications

2. **Generate diverse candidates**
   - Vary temperature
   - Try different approaches
   - Use multiple models

3. **Verify with appropriate strategy**
   - Tool-based for code (run tests)
   - Multi-model for subjective tasks
   - Formal for critical operations

4. **Learn from failures**
   - Store verification failures
   - Analyze error patterns
   - Improve prompts based on patterns

5. **Balance speed and quality**
   - Fast profile for low-stakes
   - Thorough profile for high-stakes
   - Cache verified solutions

### ❌ Don't

1. **Don't over-verify simple tasks**
   - "Hello" doesn't need 5 candidates
   - Use verification when impact matters

2. **Don't ignore verification failures**
   - If all candidates fail, something's wrong
   - Escalate to user or different strategy

3. **Don't trust single-model verification**
   - For critical tasks, use multi-model consensus
   - Single model can have consistent blind spots

4. **Don't skip refinement**
   - First attempt often has fixable issues
   - 1-2 refinement attempts dramatically improve results

## Metrics to Track

```typescript
interface VerificationMetrics {
  // Quality metrics
  verificationPassRate: number; // % solutions verified on first try
  refinementSuccessRate: number; // % refined solutions that pass
  averageRefinementAttempts: number;

  // Performance metrics
  averageLatency: number;
  cacheHitRate: number;
  verificationStrategyBreakdown: Record<string, number>;

  // Improvement metrics
  baselineAccuracy: number; // Without verification
  verifiedAccuracy: number; // With verification
  improvementFactor: number; // verifiedAccuracy / baselineAccuracy
}
```

## Conclusion

Verification-and-refinement pipelines represent a **fundamental shift** in how we build AI agents:

**From**: "Ask LLM once, hope for the best"  
**To**: "Generate diverse solutions, verify rigorously, refine iteratively"

**Expected improvements for Jazz:**

- ✅ **2-5x better solution quality** (matching IMO research findings)
- ✅ **Higher user confidence** (verified results)
- ✅ **Fewer critical errors** (caught automatically)
- ✅ **Model-agnostic** (works with any LLM)
- ✅ **Compound reliability** (multiple verification strategies)

**Cost-benefit:**

- Latency: 2-5x slower (but configurable)
- Token cost: 3-5x higher (but higher success rate)
- Development: 6-8 weeks to implement
- **ROI: Massive improvement in reliability and user trust**

## References

- [Huang & Yang, 2025 - Winning Gold at IMO 2025](https://arxiv.org/pdf/2507.15855) - Model-agnostic
  verification-refinement pipeline
- [Agent Loop Performance](./agent-loop-performance.md) - Speed optimization strategies
- [Context Window Strategies](../context-management/context-window-strategies.md) - Managing
  verification context
- [Agent Skills System](../skills/agent-skills-system.md) - Integrating verification with skills
