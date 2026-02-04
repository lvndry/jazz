# Use Case: Deep Research & Obsidian

## Overview

Perform deep web research on any topic and automatically save a formatted report to your Obsidian vault.

## Prerequisites

- **Jazz CLI** installed.
- **Obsidian** installed (no special plugin required, just file access).

## Step-by-Step

1. **Install Skills**:
   Ensure you have the `deep-research` and `obsidian` skills available.

   ```bash
   jazz skill list
   ```

2. **Run the Command**:
   Ask Jazz to research a topic and save it.

   ```bash
   jazz "Research the history of quantum computing and save a summary to my Obsidian vault under 'Research/Quantum'"
   ```

   _Or via chat interface:_

   > "Research the impact of AI on healthcare over the last 5 years. Focus on personalized medicine. Save the report to Obsidian."

3. **What Jazz Does**:
   - **Plans** a research strategy.
   - **Searches** the web using multiple queries.
   - **Reads** and analyzes relevant pages.
   - **Synthesizes** findings into a comprehensive markdown report.
   - **Saves** the file to your specified Obsidian path (e.g., `/Users/you/Obsidian/Research/Quantum.md`).

## Demo

_(Video placeholder: Deep Research Flow)_

## Customization

You can create a specialized "Researcher" agent with only these skills to keep it focused.

```bash
jazz agent create --name "Researcher" --skills "deep-research,obsidian" --model "anthropic:claude-3-5-sonnet"
```
