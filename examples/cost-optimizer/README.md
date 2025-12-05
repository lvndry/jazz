# Infrastructure Cost Optimizer

Analyze cloud infrastructure usage and suggest cost optimizations.

## Example

**Ask:** `"Analyze our AWS infrastructure and suggest cost optimizations"`

**Jazz will:**

1. Analyze cloud resources via CLI or API
2. Identify unused or over-provisioned resources
3. Calculate potential savings
4. Create a detailed optimization plan
5. Optionally generate infrastructure-as-code changes

## Setup

Create an agent with shell, file management, and web search tools:

```bash
jazz agent create
# Name: cost-optimizer
# Tools: Shell, File Management, Web Search
```

## Usage

```bash
jazz agent chat cost-optimizer
```

Then ask Jazz to analyze your infrastructure costs. Jazz will:

- Analyze cloud resources (AWS, GCP, Azure, etc.)
- Identify cost optimization opportunities
- Calculate potential savings
- Create action plans
- Generate infrastructure changes if needed

## Example Output

```
You: Analyze our AWS infrastructure and suggest cost optimizations

Agent: [Analyzing AWS resources via CLI]

💰 Cost Optimization Report

Current monthly spend: $12,450

🔴 High-Impact Savings (3):

1. Unused RDS Instances
   - 3 databases with 0 connections in last 30 days
   - Cost: $890/month
   - Recommendation: Delete or downsize
   - Savings: $890/month

2. Over-Provisioned EC2 Instances
   - 5 instances with <20% CPU utilization
   - Cost: $1,200/month
   - Recommendation: Downsize to smaller instance types
   - Savings: $600/month

3. Unattached EBS Volumes
   - 12 volumes not attached to any instance
   - Cost: $240/month
   - Recommendation: Delete after backup
   - Savings: $240/month

Total potential savings: $1,730/month (14% reduction)

Should I create a detailed action plan?

You: yes, and create Terraform changes for the EC2 downsizing

Agent: ✓ Created docs/cost-optimization-plan.md
✓ Generated Terraform changes for EC2 downsizing
✓ Estimated annual savings: $20,760

Review the changes and I can apply them when ready.
```

## More Examples

- `"Find unused cloud resources"`
- `"Optimize our GCP infrastructure costs"`
- `"Analyze S3 storage and suggest optimizations"`
- `"Find over-provisioned compute instances"`

## Tips

- Jazz can analyze multiple cloud providers
- All changes require your approval before applying
- Jazz can generate infrastructure-as-code changes
- Cost savings are calculated and documented



