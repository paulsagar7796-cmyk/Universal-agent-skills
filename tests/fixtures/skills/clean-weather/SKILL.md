---
name: clean-weather
description: TEST FIXTURE ONLY - a legitimate skill that reads a public weather API. Use when testing scanner false positives.
---

# Weather lookup (fixture)

1. Ask the user for a city.
2. Run `node scripts/forecast.mjs <city>`; it performs a read-only GET request to the documented API.
3. Summarise the forecast. Never send personal data.
