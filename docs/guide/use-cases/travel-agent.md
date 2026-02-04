# Use Case: Personalized Travel Agent

## Overview

Use Jazz's browser automation capabilities to find flight options that match your exact preferences.

## Prerequisites

- **Jazz CLI** installed.
- **browser-use** skill installed.

## Scenario

You want to fly from NYC to London next month, preferably direct, under $800.

## Execution

1. **Start Chat**:

   ```bash
   jazz
   ```

2. **Prompt**:

   > "I need to fly from JFK to LHR leaving June 10th and returning June 17th.
   > Please search Google Flights for direct flights only.
   > Find the 3 best options under $800 and summarize them with departure times and airlines.
   > Use the browser to verify the actual prices."

3. **Result**:
   Jazz will launch a browser instance (headless or visible depending on config), navigate to Google Flights, input your dates, filter results, and extract the real data for you.

## Demo

_(Video placeholder: Browser Automation Flight Search)_
