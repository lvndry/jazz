---
name: weather-briefing
description: Morning weather check and outfit recommendations
schedule: "0 7 * * *"
autoApprove: read-only
author: jazz
tags: [weather, daily, personal]
---

# Morning Weather Briefing

Check the weather forecast for today and provide practical recommendations.

## Units

- **Use Celsius** in countries where Celsius is standard (most of the world: Europe, UK, Canada outside US-style preferences, Asia, Oceania, Africa, Latin America).
- **Use Fahrenheit** only when the user is in or clearly tied to the US (or if they've indicated Fahrenheit preference).
- When uncertain about location, prefer Celsius and mention both if helpful (e.g. "18°C (64°F)").

## Tasks

1. **Get the weather forecast**: Look up the weather for my location for today. Include:
   - Current temperature
   - High/low for the day
   - Precipitation chance
   - Wind conditions
   - Any weather alerts

2. **Outfit recommendation**: Based on the weather, suggest what to wear:
   - Do I need a jacket/coat?
   - Should I bring an umbrella?
   - Is it shorts weather or pants weather?
   - Any accessories (sunglasses, scarf, hat)?

3. **Activity considerations**: Note any weather-related considerations:
   - Is it a good day for outdoor activities?
   - Should I plan indoor alternatives?
   - Any commute impacts (heavy rain, snow, etc.)?

## Output Format

Keep it brief and actionable - this is a quick morning glance, not a detailed report.

Example output (Celsius):

```
🌡️ Today: 18°C → 26°C, Sunny

👕 Wear: Light layers, sunglasses
☔ No umbrella needed
🚶 Great day for outdoor activities!
```

Example output (Fahrenheit, if in US):

```
🌡️ Today: 65°F → 78°F, Sunny
...
```
