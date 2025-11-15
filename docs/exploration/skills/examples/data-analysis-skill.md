# Example: Data Analysis Skill

A comprehensive skill for data exploration, visualization, and insights generation.

## Directory Structure

```
skills/data-analysis/
├── SKILL.md
├── data-types.md
├── analysis-patterns.md
├── visualization-guide.md
├── scripts/
│   ├── explore.py
│   ├── clean.py
│   ├── analyze.py
│   ├── visualize.py
│   └── report.py
├── notebooks/
│   ├── template-exploration.ipynb
│   └── template-report.ipynb
└── configs/
    ├── chart-themes.json
    └── analysis-presets.json
```

## SKILL.md

````yaml
---
name: data-analysis
version: 2.1.0
description: Comprehensive data exploration, analysis, and visualization
author: Data Science Team
tags: [data, analytics, visualization, statistics, reporting, insights]
category: Analytics
complexity: intermediate

tools:
  required:
    - read_file
    - write_file
    - execute_command
  optional:
    - http_request
    - send_email

triggers:
  keywords:
    - analyze
    - data
    - statistics
    - chart
    - graph
    - visualize
    - trend
    - correlation
    - insights
  patterns:
    - "analyze (this|the) data"
    - "(show|create|generate) (a )?(chart|graph|plot|visualization)"
    - "(what are|show me) the (trends|patterns|insights)"
    - "summarize (this|the) (data|dataset)"
    - "find (correlations|outliers|patterns)"
  context_hints:
    - file_extension: [".csv", ".json", ".xlsx", ".parquet"]

risk_level: low
approval_required: false

sections:
  - data-types.md
  - analysis-patterns.md
  - visualization-guide.md

estimated_duration: 5-20 minutes
prerequisites:
  - Python with pandas, matplotlib, seaborn
  - Data file or data source

last_updated: 2024-01-15
---

# Data Analysis Skill

Explore, analyze, and visualize data to uncover insights and patterns.

## Overview

Data analysis is critical for making informed decisions. This skill helps you:
- Quickly explore and understand datasets
- Clean and transform data
- Perform statistical analysis
- Create informative visualizations
- Generate automated insights
- Build comprehensive reports

## Core Capabilities

1. **Data Exploration**
   - Dataset profiling
   - Summary statistics
   - Missing value analysis
   - Data type detection
   - Distribution analysis

2. **Data Cleaning**
   - Handle missing values
   - Remove duplicates
   - Fix data types
   - Normalize/standardize
   - Outlier detection

3. **Statistical Analysis**
   - Descriptive statistics
   - Correlation analysis
   - Trend detection
   - Hypothesis testing
   - Regression analysis

4. **Visualization**
   - Line charts (trends)
   - Bar charts (comparisons)
   - Scatter plots (relationships)
   - Heatmaps (correlations)
   - Distribution plots

5. **Insights Generation**
   - Automated pattern detection
   - Anomaly identification
   - Trend interpretation
   - Actionable recommendations

## Basic Workflow

### Step 1: Load & Profile Data

```python
# scripts/explore.py
import pandas as pd

df = pd.read_csv('data.csv')

profile = {
    'rows': len(df),
    'columns': len(df.columns),
    'memory': df.memory_usage().sum() / 1024**2,  # MB
    'dtypes': df.dtypes.value_counts().to_dict(),
    'missing': df.isnull().sum().to_dict(),
    'duplicates': df.duplicated().sum()
}
````

**Output:**

```
📊 Dataset Profile

Size: 10,000 rows × 15 columns
Memory: 1.2 MB

Data Types:
  • Numeric: 8 columns
  • Text: 5 columns
  • Date: 2 columns

Data Quality:
  • Complete: 12 columns (80%)
  • Missing values: 3 columns (20%)
  • Duplicates: 45 rows (0.45%)
```

### Step 2: Clean Data

```python
# Automated cleaning
df_clean = clean_data(df, strategy='auto')

# Custom cleaning
df_clean = df.dropna(subset=['critical_column'])
df_clean['price'] = pd.to_numeric(df_clean['price'], errors='coerce')
df_clean = df_clean.drop_duplicates()
```

### Step 3: Analyze

```python
# Summary statistics
stats = df_clean.describe()

# Correlations
correlations = df_clean.corr()

# Trends over time
trends = df_clean.groupby('date')['value'].mean()
```

### Step 4: Visualize

```python
# Create visualizations
import matplotlib.pyplot as plt
import seaborn as sns

# Trend line
plt.figure(figsize=(12, 6))
plt.plot(trends.index, trends.values)
plt.title('Value Trend Over Time')
plt.savefig('trend.png')

# Correlation heatmap
plt.figure(figsize=(10, 8))
sns.heatmap(correlations, annot=True, cmap='coolwarm')
plt.savefig('correlations.png')
```

### Step 5: Generate Insights

```
🔍 Key Insights:

1. Strong Upward Trend
   • Value increased 45% over the period
   • Steady growth with seasonal peaks

2. High Correlation
   • Price and Quality: 0.87 (very strong)
   • Suggests quality drives pricing

3. Outliers Detected
   • 12 data points (0.12%) significantly outside normal range
   • May indicate data errors or special cases

4. Recommendations
   • Focus on quality to improve pricing
   • Investigate outlier transactions
   • Track seasonal patterns for forecasting
```

## Analysis Patterns

### Pattern 1: Time Series Analysis

**Use Case**: Track metrics over time, identify trends

```python
def analyze_time_series(df, date_col, value_col):
    # Resample to daily
    ts = df.set_index(date_col)[value_col].resample('D').mean()

    # Calculate trend
    from scipy.stats import linregress
    x = range(len(ts))
    slope, intercept, r_value, p_value, std_err = linregress(x, ts.values)

    # Detect seasonality
    from statsmodels.tsa.seasonal import seasonal_decompose
    decomposition = seasonal_decompose(ts, model='additive', period=7)

    return {
        'trend': 'increasing' if slope > 0 else 'decreasing',
        'slope': slope,
        'r_squared': r_value ** 2,
        'seasonality': decomposition.seasonal.mean(),
        'volatility': ts.std()
    }
```

**Example Output:**

```
📈 Time Series Analysis

Trend: Increasing ↗
  • Growth rate: +2.3% per day
  • R²: 0.85 (strong trend)

Seasonality: Weekly pattern detected
  • Peak: Tuesdays (+15%)
  • Low: Sundays (-20%)

Volatility: Moderate (σ = 125)
```

### Pattern 2: Cohort Analysis

**Use Case**: Compare user groups, retention analysis

```python
def cohort_analysis(df, cohort_col, date_col, metric_col):
    df['cohort'] = df.groupby(cohort_col)[date_col].transform('min')
    df['cohort_period'] = (df[date_col] - df['cohort']).dt.days // 7

    cohort_data = df.groupby(['cohort', 'cohort_period'])[metric_col].mean()
    cohort_pivot = cohort_data.unstack()

    # Calculate retention
    retention = cohort_pivot.divide(cohort_pivot[0], axis=0) * 100

    return retention
```

**Example Output:**

```
👥 Cohort Analysis

Retention by Week:
          Week 0  Week 1  Week 2  Week 4  Week 8
Jan 2024    100%     85%     72%     58%     45%
Feb 2024    100%     88%     75%     62%     50%
Mar 2024    100%     90%     80%     68%     56%

Insight: Retention improving month-over-month
  • Week 4 retention up 10 points (Jan → Mar)
  • Suggests product improvements working
```

### Pattern 3: Segmentation Analysis

**Use Case**: Group data by characteristics

```python
def segment_analysis(df, segment_by, metrics):
    segments = df.groupby(segment_by)[metrics].agg(['mean', 'median', 'count'])

    # Rank segments
    segments['score'] = segments.mean(axis=1)
    segments = segments.sort_values('score', ascending=False)

    return segments
```

**Example Output:**

```
🎯 Customer Segments

High Value (25%):
  • Avg Purchase: $450
  • Frequency: 8x/month
  • LTV: $43,200

Medium Value (50%):
  • Avg Purchase: $180
  • Frequency: 3x/month
  • LTV: $6,480

Low Value (25%):
  • Avg Purchase: $45
  • Frequency: 1x/month
  • LTV: $540

Recommendation: Focus retention on High Value segment
```

See [analysis-patterns.md](analysis-patterns.md) for more patterns.

## Visualization Types

### When to Use Each Chart

| Chart Type       | Best For             | Example Use Case      |
| ---------------- | -------------------- | --------------------- |
| **Line Chart**   | Trends over time     | Revenue growth        |
| **Bar Chart**    | Comparing categories | Sales by region       |
| **Scatter Plot** | Relationships        | Price vs. Quality     |
| **Histogram**    | Distributions        | Age distribution      |
| **Box Plot**     | Outlier detection    | Response time ranges  |
| **Heatmap**      | Correlations         | Feature relationships |
| **Pie Chart**    | Proportions          | Market share          |

See [visualization-guide.md](visualization-guide.md) for detailed guide.

## Code Resources

### scripts/explore.py

Automated data exploration and profiling.

**Usage:**

```bash
python scripts/explore.py --file data.csv --output report.html
```

**Features:**

- Dataset overview
- Column profiling
- Missing value analysis
- Distribution plots
- Correlation matrix

### scripts/clean.py

Data cleaning and transformation.

**Usage:**

```bash
python scripts/clean.py --file data.csv --strategy auto --output clean_data.csv

Options:
  --strategy    auto|conservative|aggressive
  --drop-na     Drop rows with missing values
  --fill-na     Fill missing values (mean|median|mode)
  --dedupe      Remove duplicates
```

### scripts/analyze.py

Statistical analysis.

**Usage:**

```bash
python scripts/analyze.py --file data.csv --analysis trend

Analysis Types:
  trend          Time series trend analysis
  correlation    Correlation analysis
  cohort         Cohort analysis
  segment        Segmentation analysis
  outliers       Outlier detection
```

### scripts/visualize.py

Generate visualizations.

**Usage:**

```bash
python scripts/visualize.py --file data.csv --chart line --x date --y value

Chart Types:
  line           Line chart
  bar            Bar chart
  scatter        Scatter plot
  heatmap        Correlation heatmap
  distribution   Distribution plot
```

### scripts/report.py

Generate comprehensive analysis report.

**Usage:**

```bash
python scripts/report.py --file data.csv --format html --output report.html

Formats:
  html           Interactive HTML report
  pdf            PDF document
  markdown       Markdown report
```

## Example Usage

### Example 1: Sales Data Analysis

```
User: "Analyze this sales data"

Agent: [Loads data-analysis skill]
Agent: [Reads sales.csv]
Agent: "📊 Analyzing sales data..."

Agent: [Runs explore.py]
Agent: "Dataset Profile:
  • 5,000 transactions
  • 12 columns
  • Date range: Jan 1 - Dec 31, 2023
  • Total revenue: $2.4M

Exploring data..."

Agent: [Runs analyze.py --analysis trend]
Agent: "📈 Sales Trends:

Key Findings:

1. Strong Growth 📈
   • Q1: $450K
   • Q2: $520K (+15%)
   • Q3: $680K (+31%)
   • Q4: $750K (+10%)
   • YoY Growth: 67%

2. Seasonal Patterns
   • Peak: November (Black Friday)
   • Low: January (post-holiday)
   • 35% variance

3. Top Products
   • Product A: $840K (35%)
   • Product B: $600K (25%)
   • Product C: $360K (15%)

4. Regional Performance
   • West: $1.2M (50%)
   • East: $720K (30%)
   • South: $480K (20%)

Creating visualizations..."

Agent: [Runs visualize.py]
Agent: "✅ Created 4 charts:
  1. sales_trend.png - Monthly revenue
  2. products_breakdown.png - Product mix
  3. regional_sales.png - Sales by region
  4. growth_chart.png - YoY comparison

💡 Strategic Insights:

1. West region driving growth - expand presence
2. Product A is star performer - increase inventory
3. Q4 shows strong momentum - maintain into Q1
4. Consider promotions for January slump

Would you like me to:
  • Generate detailed PDF report
  • Break down by customer segment
  • Forecast next quarter
  • Analyze customer retention"
```

### Example 2: Website Analytics

```
User: "Show me user behavior trends from this analytics data"

Agent: [Loads data-analysis skill]
Agent: [Reads analytics.csv]

Agent: "📊 Analyzing 100K user sessions..."

Agent: [Runs analyze.py]
Agent: "🔍 User Behavior Analysis

Traffic Trends:
  • Daily visitors: 8,500 (avg)
  • Peak traffic: 2-4pm EST
  • Growth: +12% month-over-month

Engagement:
  • Avg session: 4:23 minutes
  • Bounce rate: 42% (down from 48%)
  • Pages per session: 3.2

Conversion Funnel:
  • Homepage: 100% (100K)
  • Product page: 45% (45K)
  • Cart: 12% (12K)
  • Checkout: 8% (8K)
  • Purchase: 6% (6K)

  → Biggest drop: Product → Cart (33% drop)

Top Pages:
  1. /products/shoes - 25K visits
  2. /sale - 18K visits
  3. /about - 12K visits

User Sources:
  • Organic search: 45%
  • Direct: 30%
  • Social: 15%
  • Paid: 10%

📈 Recommendations:

1. Optimize product-to-cart conversion
   • Add clearer CTAs
   • Show urgency/scarcity
   • Improve product photos

2. Capitalize on peak hours
   • Schedule promotions 2-4pm
   • Ensure performance during peak

3. Invest in organic search
   • 45% of traffic, high intent
   • Improve SEO for top products"
```

### Example 3: Customer Satisfaction

```
User: "Analyze this customer survey data"

Agent: [Loads data-analysis skill]
Agent: [Reads survey_responses.csv]

Agent: "📊 Survey Analysis (2,500 responses)

Overall Satisfaction: 7.8/10 (Good)

By Category:
  • Product Quality: 8.5/10 ⭐
  • Customer Service: 7.2/10 ⚠️
  • Shipping Speed: 6.8/10 ⚠️
  • Value for Money: 8.0/10 ⭐
  • Website UX: 7.5/10

Sentiment Analysis:
  • Positive: 65%
  • Neutral: 25%
  • Negative: 10%

Common Complaints (from text responses):
  1. "Slow shipping" (mentioned 340 times)
  2. "Hard to reach support" (mentioned 180 times)
  3. "Confusing checkout" (mentioned 120 times)

Top Praise:
  1. "Great product quality" (mentioned 890 times)
  2. "Good prices" (mentioned 450 times)

Correlation Analysis:
  • Shipping speed most impacts overall satisfaction (r=0.72)
  • Customer service second (r=0.65)

🎯 Action Items:

1. URGENT: Improve shipping speed
   • Biggest impact on satisfaction
   • Consider faster shipping options
   • Set expectations clearly

2. Expand customer service
   • Add chat support
   • Extend hours
   • Reduce response time

3. Simplify checkout
   • UX testing needed
   • Reduce steps
   • Add progress indicator"
```

## Best Practices

1. **Start with exploration**
   - Understand data before analyzing
   - Check for quality issues
   - Profile distributions

2. **Clean thoughtfully**
   - Don't over-clean
   - Document transformations
   - Keep raw data backup

3. **Choose appropriate visualizations**
   - Match chart type to data type
   - Keep it simple
   - Label clearly

4. **Validate assumptions**
   - Check statistical significance
   - Consider sample size
   - Account for confounding factors

5. **Tell a story**
   - Start with key insights
   - Support with data
   - End with recommendations

## Common Analysis Workflows

### Workflow 1: Business Metrics Dashboard

```bash
# Daily automated report
python scripts/explore.py --file daily_metrics.csv
python scripts/analyze.py --analysis trend
python scripts/visualize.py --chart line --x date --y revenue
python scripts/report.py --format html --email team@company.com
```

### Workflow 2: Ad-hoc Investigation

```bash
# Quick exploration
python scripts/explore.py --file data.csv --quick

# Deep dive if interesting
python scripts/clean.py --file data.csv --strategy auto
python scripts/analyze.py --analysis correlation
python scripts/visualize.py --chart heatmap
```

### Workflow 3: Recurring Analysis

```bash
# Weekly cohort analysis
python scripts/analyze.py --file users.csv --analysis cohort
python scripts/visualize.py --chart heatmap --x cohort --y retention
python scripts/report.py --format pdf --output weekly_cohort.pdf
```

## Configuration

`configs/analysis-presets.json`:

```json
{
  "sales_analysis": {
    "metrics": ["revenue", "units", "profit"],
    "dimensions": ["product", "region", "channel"],
    "time_grouping": "month",
    "visualizations": ["trend", "breakdown", "comparison"]
  },
  "user_analytics": {
    "metrics": ["sessions", "pageviews", "conversions"],
    "dimensions": ["source", "device", "landing_page"],
    "time_grouping": "day",
    "visualizations": ["funnel", "retention", "engagement"]
  },
  "financial_reporting": {
    "metrics": ["revenue", "expenses", "profit", "cash_flow"],
    "dimensions": ["department", "category"],
    "time_grouping": "quarter",
    "visualizations": ["waterfall", "comparison", "forecast"]
  }
}
```

## Related Skills

Works well with:

- **reporting**: Create polished reports from analysis
- **forecasting**: Predict future trends
- **monitoring**: Track KPIs and metrics

## Changelog

### v2.1.0 (2024-01-15)

- Added AI-powered insight generation
- Improved automated cleaning
- New visualization types

### v2.0.0 (2023-12-01)

- Complete rewrite with pandas
- Interactive visualizations
- Automated reporting

### v1.0.0 (2023-08-01)

- Initial release
- Basic statistics
- Simple charts

```

---

This data analysis skill demonstrates:
- ✅ Comprehensive data exploration
- ✅ Statistical analysis patterns
- ✅ Multiple visualization types
- ✅ Automated insight generation
- ✅ Real-world business use cases
- ✅ Actionable recommendations

```
