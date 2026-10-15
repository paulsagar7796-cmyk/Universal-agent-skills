---
name: data-analysis
description: Analyses tabular or experimental data rigorously - profiles the data first, checks for leakage between train and test splits, chooses statistical tests whose assumptions hold, reports effect sizes and confidence intervals rather than bare p-values, corrects for multiple comparisons, and keeps notebooks reproducible. Use for exploratory analysis, statistics, A/B or experiment analysis, dataset checks, data leakage, p-values, or cleaning and validating datasets.
license: Apache-2.0
metadata:
  version: "0.1.0"
  category: data
  maturity: draft
  risk: low
---

# Data analysis

Numbers you report must be reproducible from the data and code, and the uncertainty around them must be stated.

## Workflow

1. **Understand the question** and the unit of analysis (row = patient? sample? event?). Ask if unclear.
2. **Profile before modelling**: shape, column types, units, missing values per column, duplicates, value ranges,
   class balance, time span. Note anything odd (mixed units, sentinel values like -999, impossible values).
3. **Leakage check** whenever there are train/validation/test files or a split column:
   `python3 scripts/leakage_check.py train.csv test.csv --id <id column> --target <label column>`
   (standard library only; reads local files, sends nothing anywhere). It reports exact duplicate rows across splits,
   overlapping IDs, and features that are near-copies of the target. Also think about leakage it cannot see: future
   information, preprocessing fitted on all data, group leakage (same patient/subject in both splits).
4. **Choose the analysis to fit the question and data**: state assumptions (independence, normality, equal variance)
   and check them; prefer robust or non-parametric alternatives when they fail; for paired data use paired tests.
5. **Report effect sizes with confidence intervals** (difference in means, odds ratio, Cohen's d …) alongside p-values.
   A p-value alone is not a finding.
6. **Multiple comparisons**: when testing many hypotheses, say how many and correct (Holm, Benjamini–Hochberg).
   Never search through tests until something is significant; if exploration was open-ended, label results
   exploratory.
7. **Reproducibility**: fixed seeds, notebooks that run top to bottom (restart-and-run-all), relative paths, pinned
   environment, raw data never modified in place (write cleaned data to a new file). `brain init` flags notebooks
   run out of order, missing seeds and absolute paths.
8. **Record** key findings in the brain with evidence (`brain remember … --evidence file:<notebook or results file>`),
   and analysis runs with `brain exp` when they produce metrics.

## Stop and ask when

- The request is to "find something significant" — explain why that invalidates the result and propose a
  pre-specified analysis instead.
- Data looks personal or sensitive (health, genetics, identifiers): confirm it may be analysed here; never upload it
  to an external service without explicit approval (`upload-sensitive-data`).

## Never

- Report results from data you did not load, invent values, or silently drop rows/outliers (say what was removed and why).
- Copy raw data rows into the brain, reports or chat beyond small illustrative examples without personal data.

## Output contract

```
Data: <files, rows, columns, period>   Quality issues: <missing, duplicates, units>
Leakage check: <result or "not applicable">
Method: <test/model and why; assumptions checked>
Results: <estimate, 95% CI, p (corrected if applicable), n>
Limitations: <what this analysis cannot show>
```
