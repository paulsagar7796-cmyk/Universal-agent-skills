---
name: ml-experiment
description: Designs, runs, records and honestly compares machine-learning experiments - question and hypothesis first, a baseline, one change at a time (ablation), several seeds, untouched test set, every run recorded with config, data hashes and metrics from result files, and no claimed improvement unless a comparison over seeds supports it. Use when training or evaluating models, tuning, ablations, comparing variants, or writing up ML results.
license: Apache-2.0
metadata:
  version: "0.1.0"
  category: ml
  maturity: draft
  risk: medium
---

# ML experiment

The goal is a result someone else could reproduce and believe. A clean "no difference" is a valid outcome; an
unsupported "+0.4%" is not.

## Before training

1. **Question and hypothesis** in one sentence each, plus the metric and the split it is measured on, and what result
   would change your mind. If the user has not said, ask.
2. **Baseline.** Identify the run you compare against (an existing `EXP-…`, a published number with source, or a simple
   model you train now). No baseline → no comparison.
3. **One change at a time.** Compare variants that differ in one factor; for several factors, plan an ablation table.
4. **Seeds.** Plan at least 3 seeds per variant (5 when differences are small). Set seeds for Python, NumPy and the
   framework (`torch.manual_seed`, `tf.random.set_seed`, `jax.random.PRNGKey`) and record them.
5. **Data hygiene.** Train/validation/test splits fixed and recorded; the **test set stays untouched** until the final
   evaluation; check for leakage (duplicates across splits, target or future information in features — see the
   `data-analysis` skill).
6. **Cost.** Long GPU jobs, cloud instances, large downloads: state the expected cost/time and get the user's explicit
   approval first (`run-expensive-compute`, `download-large-data`). Never start them on your own.

## Recording every run

If the project brain exists (`.agent-brain/`):

```bash
brain exp start --title "<variant>" --question "…" --baseline EXP-0003 \
  --config configs/x.yaml --data train=data/train.parquet --data val=data/val.parquet \
  --split "<how the split was made>" --seed 1 --seed 2 --seed 3
# run training; make it write a results file per seed (JSON or CSV)
brain exp log EXP-0007 --from runs/seed1/metrics.json --seed 1      # repeat per seed
brain exp finish EXP-0007 --status completed --conclusion "<only what the comparison supports>"
brain exp compare EXP-0003 EXP-0007 --metric val_acc               # --lower-better for losses
```

Metrics come only from result files; never type numbers into the record or a report. Commit code before starting
(uncommitted changes make the run non-reproducible and are flagged). Without the brain, keep the same fields in a
markdown or CSV experiment log next to the results.

## Reporting

- Report **mean ± spread over seeds** and n, the baseline's numbers, the split, and the test used.
- Use the `brain exp compare` verdict: `improved` / `worse` / `no-clear-difference` / `insufficient-seeds` /
  `not-comparable`. Do not upgrade it in prose. Many variants tested → say so (multiple comparisons).
- Validation results are not test results. Report the test score once, for the final chosen configuration.
- State what was **not** done (seeds not run, test set not evaluated, hyperparameters not tuned for the baseline).

## Debugging training

Follow [references/training-debugging.md](references/training-debugging.md) for NaN/exploding loss, loss not
decreasing, overfitting, suspiciously good scores (usually leakage), and out-of-memory errors. Diagnose before changing
hyperparameters at random.

## Never

- Claim an improvement from one seed, from validation tuning reported as test, or across different data/splits.
- Peek at or tune on the test set; delete unfavourable runs; change the metric after seeing results.
- Start paid compute, large downloads or uploads of data without explicit approval.
- Store datasets, model weights or credentials in the brain (record paths and hashes only).
