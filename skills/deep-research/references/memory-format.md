# Deep Research Memory Format

Structured persistence system for tracking research progress, findings, and user interactions across research sessions.

## Overview

The memory system uses YAML files to maintain research state, enabling:

- **Context Persistence**: Resume interrupted research sessions
- **Progress Tracking**: Monitor research phases and completion
- **User Interaction History**: Record feedback and course corrections
- **Finding Organization**: Structured storage of claims, sources, and contradictions
- **Collaboration Support**: Shareable research state for team collaboration

## File Structure & Naming

### File Naming Convention
```
research-memory-[research-id]-[timestamp].yaml
```

**Example:**
- `research-memory-ai-healthcare-2024-01-15-143022.yaml`
- `research-memory-crypto-regulation-2024-02-03-091500.yaml`

### Directory Organization
```
research-projects/
├── active/
│   ├── research-memory-ai-healthcare-2024-01-15-143022.yaml
│   └── research-memory-crypto-trends-2024-02-01-160000.yaml
├── completed/
│   ├── research-memory-blockchain-scaling-2023-12-15-110000.yaml
│   └── research-memory-quantum-computing-2023-12-01-090000.yaml
└── archived/
    └── research-memory-obsolete-topic-2023-06-01-120000.yaml
```

## YAML Schema

### Root Structure

```yaml
research:
  # Metadata
  id: string                    # Unique research identifier
  question: string              # Original research question
  started_at: ISO8601           # Research initiation timestamp
  last_updated: ISO8601         # Last modification timestamp
  status: enum                  # Current research status

  # User Context
  user_constraints: object      # User preferences and requirements
  user_profile: object          # User background and expertise level

  # Research Structure
  phases: object               # Progress tracking by phase
  findings: object             # Research results and analysis
  sources: object              # Source tracking and metadata
  checkpoints: array           # User interaction points

  # Synthesis
  synthesis: object            # Final report planning
```

## Detailed Schema

### Research Metadata

```yaml
research:
  id: "deep-research-2024-01-15-143022"
  question: "How will AI impact healthcare costs in the next decade?"
  started_at: "2024-01-15T14:30:22Z"
  last_updated: "2024-01-15T16:45:10Z"
  status: "in_progress"  # planning|researching|checkpoint|synthesizing|completed|paused

  estimated_completion: "2024-01-15T18:00:00Z"
  time_spent_minutes: 135
  search_budget_used: 23
  search_budget_total: 50
```

### User Constraints

```yaml
user_constraints:
  depth: "comprehensive"        # overview|detailed|comprehensive|expert
  time_frame: "next decade"     # Specific time constraints
  expected_output: "detailed report with sources"
  special_requirements:
    - "PDF analysis required"
    - "academic papers preferred"
    - "cost-benefit focus"
  source_preferences:
    - "academic"
    - "industry_reports"
    - "government_data"
  expertise_level: "intermediate"  # beginner|intermediate|expert
```

### User Profile (Optional)

```yaml
user_profile:
  domain_expertise: ["healthcare", "technology"]
  previous_interactions: ["research-session-2023-11-15"]
  preferred_formats: ["detailed_reports", "executive_summaries"]
  time_preferences: "thorough_over_fast"
```

### Phases Tracking

```yaml
phases:
  planning:
    completed: true
    timestamp: "2024-01-15T14:30:45Z"
    duration_minutes: 15
    user_responses:
      research_approach: "multi-source with academic focus"
      key_areas: ["cost savings", "adoption barriers", "predictions"]
      depth_preference: "in-depth with primary sources"

  decomposition:
    completed: true
    timestamp: "2024-01-15T14:45:22Z"
    duration_minutes: 20
    sub_questions:
      - id: "current_applications"
        question: "What are current AI applications in healthcare?"
        status: "completed"
        priority: "high"
        search_queries: ["AI healthcare applications 2024", "ML medical tools"]
        sources_found: 8

  research:
    current_batch: 2
    total_batches: 4
    batches:
      batch_1:
        status: "completed"
        timestamp: "2024-01-15T15:05:33Z"
        queries:
          - "AI diagnostic tools hospitals"
          - "machine learning medical imaging"
        sources_found: 12
        duration_minutes: 25

      batch_2:
        status: "in_progress"
        queries:
          - "AI healthcare cost savings studies"
          - "ROI AI medical tools 2024"
        sources_found: 7
        duration_minutes: 18

  verification:
    status: "pending"
    claims_verified: 0
    total_claims: 15

  synthesis:
    status: "pending"
    outline_completed: false
```

### Findings Organization

```yaml
findings:
  key_claims:
    - id: "diagnostic_accuracy_improvement"
      claim: "AI improves diagnostic accuracy by 10-30% across medical imaging"
      confidence: "high"  # very_high|high|medium|low|very_low
      sources: ["source_001", "source_012", "source_015"]
      verification_status: "triangulated"  # single|corroborated|triangulated|contradicted
      categories: ["diagnostic_improvement", "quantitative_benefit"]
      first_discovered: "2024-01-15T15:15:30Z"
      last_updated: "2024-01-15T15:45:12Z"
      evidence_strength: "strong"
      contradictions: []  # References to contradicting claims

    - id: "implementation_costs_high"
      claim: "Initial AI implementation costs $500K-$2M per hospital"
      confidence: "medium"
      sources: ["source_008"]
      verification_status: "single_source"
      categories: ["implementation_challenges", "cost_factors"]
      first_discovered: "2024-01-15T15:32:45Z"
      last_updated: "2024-01-15T15:32:45Z"
      evidence_strength: "moderate"
      contradictions: ["claim_003"]  # Reference to contradicting claim

  contradictions:
    - id: "adoption_timeline_debate"
      claim_a: "AI adoption will be rapid (2-3 years)"
      claim_a_sources: ["industry_report_2024"]
      claim_b: "AI adoption will be gradual (5-7 years)"
      claim_b_sources: ["academic_review_2023", "government_study_2024"]
      resolution_strategy: "investigate_further"
      resolution_status: "unresolved"
      impact_on_conclusions: "high"
      user_feedback_needed: true

  emerging_themes:
    - id: "roi_varies_by_specialty"
      description: "AI ROI is higher in radiology vs primary care"
      supporting_claims: ["claim_005", "claim_012", "claim_018"]
      strength: "strong"
      first_noted: "2024-01-15T15:50:22Z"

  gaps_and_limitations:
    - id: "long_term_cost_data"
      description: "Limited longitudinal studies beyond 3 years"
      impact: "affects prediction confidence"
      mitigation_strategy: "focus on expert predictions and models"
      status: "acknowledged"

  research_questions:
    - id: "regulatory_impact"
      question: "How will FDA regulations affect AI adoption timeline?"
      status: "identified"
      priority: "medium"
      emerged_from: "analysis of implementation barriers"
```

### Sources Tracking

```yaml
sources:
  source_001:
    id: "source_001"
    title: "Artificial Intelligence in Medical Imaging: A Systematic Review"
    type: "academic"  # academic|news|official|expert|blog|industry|government
    url: "https://example.com/ai-imaging-review-2024.pdf"
    date: "2024-01-10"
    publication: "Journal of Medical AI"
    authors: ["Dr. Sarah Johnson", "Dr. Michael Chen"]
    credibility_score: 14  # 5-15 scale
    credibility_factors:
      authority: 3
      recency: 3
      evidence: 3
      bias: 3
      corroboration: 2
    key_claims: ["diagnostic_accuracy_improvement", "radiology_ai_roi"]
    content_extracted: true
    pdf_analyzed: true
    full_text_available: true
    citation_count: 45
    doi: "10.1234/medai.2024.001"

  source_012:
    id: "source_012"
    title: "AI Healthcare Market Report 2024"
    type: "industry"
    url: "https://industry-research.com/ai-healthcare-2024"
    date: "2024-01-05"
    publication: "TechHealth Analytics"
    credibility_score: 11
    key_claims: ["market_growth_prediction", "implementation_costs_high"]
    content_extracted: true
    paywall_status: "accessible"
```

### Checkpoints & User Interactions

```yaml
checkpoints:
  - id: "initial_planning_complete"
    timestamp: "2024-01-15T14:45:00Z"
    type: "planning_complete"
    summary: "Research plan established with 6 sub-questions"
    user_interaction: "confirmed direction and depth preferences"
    next_actions: ["start_batch_1_search"]

  - id: "batch_1_complete"
    timestamp: "2024-01-15T15:25:00Z"
    type: "research_checkpoint"
    summary: "Found 12 sources, identified 8 key claims"
    findings_summary: "Strong evidence for diagnostic improvements, mixed evidence on cost savings"
    user_questions:
      - "Should we prioritize radiology-specific studies?"
      - "Are you interested in international comparisons?"
    user_responses:
      - "Yes, radiology is key area"
      - "International comparison would be valuable"
    adjustments_made:
      - "Added radiology-specific queries to batch 2"
      - "Added international comparison sub-question"

  - id: "contradiction_identified"
    timestamp: "2024-01-15T16:00:00Z"
    type: "verification_issue"
    summary: "Found contradiction on AI adoption timeline"
    issue_details: "Industry reports predict rapid adoption, academic studies suggest gradual"
    user_questions:
      - "Which perspective interests you more?"
      - "Should we investigate this contradiction further?"
    user_responses:
      - "Both perspectives important"
      - "Yes, investigate regulatory and implementation factors"
    adjustments_made:
      - "Added regulatory impact analysis"
      - "Extended search for implementation case studies"
```

### Synthesis Planning

```yaml
synthesis:
  status: "in_progress"  # pending|outlining|writing|reviewing|completed
  outline_completed: true
  outline:
    executive_summary:
      content: "AI expected to reduce healthcare costs by 5-15% within 5 years through improved diagnostics and efficiency"
      key_points:
        - "Diagnostic accuracy improvements: 10-30%"
        - "Administrative automation potential: 20-40% cost reduction"
        - "Implementation challenges remain significant"

    key_findings:
      - section: "Current State"
        claims: ["diagnostic_accuracy_improvement", "current_adoption_rates"]
        subsections:
          - "Radiology AI mature, primary care emerging"
          - "Cost savings documented but variable"

      - section: "Future Projections"
        claims: ["cost_reduction_predictions", "adoption_timeline_debate"]
        subsections:
          - "Conservative estimates: 5-10% cost reduction by 2030"
          - "Optimistic scenarios: 15-25% with full automation"

    analysis:
      - section: "Cost-Benefit Analysis"
        content: "ROI varies by specialty and implementation scale"
      - section: "Risks and Challenges"
        content: "Regulatory uncertainty, integration costs, training requirements"

    limitations:
      - "Limited long-term data beyond 3 years"
      - "Geographic focus on US/European markets"
      - "Variability across medical specialties"

    recommendations:
      - "Prioritize radiology and administrative automation"
      - "Invest in physician training and change management"
      - "Monitor regulatory developments closely"

  confidence_assessment:
    overall_confidence: "high"
    breakdown:
      current_state: "very_high"
      short_term_predictions: "high"
      long_term_predictions: "medium"
      implementation_factors: "high"

  final_report:
    format: "comprehensive_report"
    sections_completed: ["executive_summary", "key_findings"]
    word_count_estimate: 2500
    sources_cited: 28
```

## Memory Operations

### Create New Research Memory

```yaml
# Initialize when research starts
research:
  id: "deep-research-${timestamp}"
  question: "${user_question}"
  started_at: "${current_timestamp}"
  status: "planning"
  user_constraints: {}  # To be filled during planning questions
```

### Update Memory Operations

**After Phase Completion:**
```yaml
phases:
  ${phase_name}:
    completed: true
    timestamp: "${current_timestamp}"
    duration_minutes: ${calculate_duration}
```

**After Finding New Claim:**
```yaml
findings:
  key_claims:
    - id: "${claim_id}"
      claim: "${claim_text}"
      confidence: "${assessed_confidence}"
      sources: ["${source_id}"]
      verification_status: "single"
      first_discovered: "${current_timestamp}"
```

**After User Checkpoint:**
```yaml
checkpoints:
  - id: "${checkpoint_id}"
    timestamp: "${current_timestamp}"
    type: "research_checkpoint"
    summary: "${findings_summary}"
    user_questions: ${user_questions_array}
    user_responses: ${user_responses_array}
    adjustments_made: ${adjustments_array}
```

### Memory Queries (Logic Examples)

These examples illustrate the logic for querying the memory structure. In implementation, these would be performed by the agent after parsing the YAML.

**Find Unanswered Questions:**
```yaml
# Logic: phases.decomposition.sub_questions where status != "completed"
query:
  path: "phases.decomposition.sub_questions"
  filter:
    field: "status"
    operator: "not_equals"
    value: "completed"
```

**Find High-Confidence Claims:**
```yaml
# Logic: findings.key_claims where confidence is "very_high" or "high"
query:
  path: "findings.key_claims"
  filter:
    field: "confidence"
    operator: "in"
    value: ["very_high", "high"]
```

**Find Source Gaps:**
```yaml
# Logic: findings.key_claims where sources count < 2 and confidence is "low"
query:
  path: "findings.key_claims"
  filter:
    all_of:
      - field: "sources"
        operator: "length_less_than"
        value: 2
      - field: "confidence"
        operator: "equals"
        value: "low"
```

## Memory File Management

### Backup Strategy
- Create backup before major updates
- Version control for significant changes
- Archive completed research memories

### Cleanup Rules
- Remove temporary analysis files after synthesis
- Compress old memory files (6+ months)
- Archive research memories after 1 year

### Sharing & Export
- Export memory as clean YAML for sharing
- Generate research summary from memory
- Support import of external research memories

## Integration with Research Pipeline

### Memory-Driven Decisions

1. **Planning Phase**: Store user preferences and constraints
2. **Search Phase**: Track query batches and source discovery
3. **Verification Phase**: Record confidence assessments and contradictions
4. **Synthesis Phase**: Build report structure from accumulated findings

### Automated Memory Updates

- **Phase Transitions**: Automatically update status and timestamps
- **Source Addition**: Immediately record new sources with metadata
- **Claim Discovery**: Add claims with initial confidence assessment
- **User Interactions**: Log all checkpoints and feedback

### Memory Recovery

- **Resume Interrupted Research**: Load last state and continue
- **Handle Crashes**: Memory state allows recovery from any point
- **Version Conflicts**: Timestamp-based conflict resolution
- **Data Integrity**: Validate memory structure on load

This memory format provides comprehensive tracking while remaining human-readable and machine-processable, enabling both automated research continuation and human oversight.
