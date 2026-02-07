---
name: budget
description: Create and manage budgets, track spending, and plan savings. Use when the user wants to budget, track expenses, plan savings, or allocate income. Triggers on "budget", "expenses", "savings goal", "track spending", "monthly budget", "50/30/20", "envelope budget".
---

# Budget

Create budgets, track spending, and plan savings. For planning and awareness only—not tax or legal advice.

## When to Use

- User wants to create or revise a budget
- User wants to track or categorize expenses
- User has a savings goal and wants a timeline or plan
- User asks how to allocate income (e.g. 50/30/20)
- User has income/expense data and wants a summary or breakdown

## Workflow

1. **Clarify scope**: Monthly? Weekly? One-off project? What's the goal (spending control, savings target, debt payoff)?
2. **Gather numbers**: Income(s), fixed expenses, variable expenses, current savings, target amount or date
3. **Choose format**: Allocation rule (e.g. 50/30/20), category list, or custom
4. **Build budget**: Categories, amounts, and (if applicable) savings/debt line
5. **Optional**: Timeline to reach a goal, or "what if" (e.g. cut X to save Y by when)

## Budget Frameworks

### 50/30/20

- **50%** needs (housing, utilities, insurance, minimum debt, groceries, essentials)
- **30%** wants (dining, entertainment, subscriptions, non-essential)
- **20%** savings and debt payoff (above minimums)

Use when the user asks for "50/30/20" or a simple allocation. Compute from monthly gross or net income per user preference. For more frameworks, see [references/frameworks.md](references/frameworks.md).

### Zero-Based (Every Dollar Has a Job)

- Income − All allocations = 0
- Categories: needs, wants, savings, debt, sinking funds
- No "leftover"; assign every dollar

Use when the user wants strict planning or "zero-based" budgeting.

### Category / Envelope Style

- List categories (rent, food, transport, fun, savings, etc.)
- Set a cap per category per month
- Track spending per category (user provides or estimates)

Use when the user has a list of categories or wants to "envelope" by category.

### Savings-First

- Set savings (and/or debt payoff) amount first
- Budget the rest for expenses
- Formula: Income − Savings = Spending allowance

Use when the user's main goal is hitting a savings target.

## Output Format

```markdown
# Budget: [Title — e.g. Monthly 2025]

## Summary

[Income, total planned spending, planned savings, and one-line takeaway.]

## Income

| Source   | Amount   |
| -------- | -------- |
| [Source] | [Amount] |

## Planned Spending

### Needs (or Fixed)

| Category   | Amount   |
| ---------- | -------- |
| [Category] | [Amount] |

### Wants (or Variable)

| Category   | Amount   |
| ---------- | -------- |
| [Category] | [Amount] |

### Savings & Debt

| Category       | Amount   |
| -------------- | -------- |
| [Savings/Debt] | [Amount] |

## Totals

- Income: [total]
- Planned spending: [total]
- Planned savings: [total]
- Difference: [surplus/deficit]

## [Optional] Savings Goal

- Target: [amount]
- Monthly to save: [amount]
- At this rate: [time to goal] (assuming no change)
```

## Savings Goals

When the user has a target amount or date:

- **Target + date** → Required monthly (or weekly) savings = Target / Months (or weeks) to date
- **Target + monthly amount** → Time to goal = Target / Monthly amount (in months)
- **Current + monthly + rate** → Simple projection: "In N months you'd have about X" (no interest or inflation unless user asks; state assumptions)

Always state assumptions (e.g. no interest, no tax, nominal amounts).

## Tracking Expenses

When the user wants to track or categorize spending:

- **Categories**: Use their list or suggest a simple set (housing, food, transport, utilities, insurance, discretionary, savings, debt).
- **Format**: Table or list with category and amount; optional percentage of income.
- **If they provide a list**: Map items to categories and sum; show breakdown and total.

Don't invent transactions; use only what the user provides.

## Time Scope

- **Monthly** is the default for personal budgets unless the user says weekly, annual, or one-off.
- **Annual**: Multiply monthly by 12 or use annual income/expenses if that's what they give.
- State the period clearly (e.g. "Monthly budget" or "January–December 2025").

## Caveats

- Round to sensible precision (e.g. whole dollars for budgets).
- State if numbers are gross vs net, and currency.
- Remind that this is for planning; tax or legal questions need a professional.

## Anti-Patterns

- ❌ Making up income or expenses; use only user-provided or clearly estimated values
- ❌ Guaranteeing outcomes (e.g. "you will reach your goal by X")
- ❌ Giving tax or legal advice; point to a professional when relevant
- ❌ Unclear time period (monthly vs annual) or currency
