# Using the toolkit for ML, data and research projects

For solo ML/AI developers and researchers (data analysis, bioinformatics, scientific computing). Commands assume
`alias brain="node ~/agent-skills-brain/bin/brain.js"`.

## What you get

| Need | What to use |
|---|---|
| The agent understands your research project at session start | `brain init` / `brain setup` — notebooks, ML/science libraries and versions, CUDA pins, data/model folders (names and sizes only), DVC/LFS, Snakemake/Nextflow, reference genome builds |
| Reproducibility warnings | Notebooks run out of order, cells never run, no seeds, machine-specific paths, mixed genome builds, data without versioning |
| A trustworthy experiment log | `brain exp` — every run with code commit, config/data hashes, split, seeds, environment and metrics read from result files |
| Honest comparisons | `brain exp compare` — Welch's t-test over seeds; refuses "improved" with < 3 seeds or different data/splits |
| Skills | `ml-experiment`, `data-analysis`, `literature-review`, `bioinformatics-pipeline` (plus the general skills) |

## Recording experiments

```bash
git commit -am "label smoothing variant"             # uncommitted code is flagged as non-reproducible
brain exp start --title "baseline" --config configs/base.yaml \
  --data train=data/train.parquet --data val=data/val.parquet --split "random 80/20, seed 42" \
  --seed 1 --seed 2 --seed 3
for s in 1 2 3; do python train.py --config configs/base.yaml --seed $s --out runs/base_s$s.json; done
for s in 1 2 3; do brain exp log EXP-0001 --from runs/base_s$s.json --select val.acc --seed $s; done
brain exp finish EXP-0001 --status completed

# variant: same data and split, --baseline EXP-0001 … then
brain exp compare EXP-0001 EXP-0002 --metric val.acc            # --lower-better for losses
brain exp list
```

What is captured automatically: git commit, branch and uncommitted changes; SHA-256 of configs and data (full for files
up to 256 MB; size + first/last 8 MB above that, marked `partial`; directories by a listing of names and sizes);
Python and library versions (torch, tensorflow, jax, sklearn, numpy, pandas — by importing them, skip with
`--no-env-probe`), CUDA availability, and GPU names from `nvidia-smi` when present.

Metrics: `--from` accepts `.json` (nested keys flattened with dots), `.jsonl` (last line or `--row`), `.csv`/`.tsv`
(last row or `--row`). Export TensorBoard or W&B summaries to one of these. There is no way to type a metric value.

Comparison verdicts: `improved`, `worse`, `no-clear-difference` (p ≥ 0.05), `insufficient-seeds` (< 3 runs per side by
default, `--min-seeds`), `not-comparable` (different data fingerprints, different split, missing metric). Use
`--baseline-metric` when the same metric is named differently in the two runs. Few seeds → low statistical power;
many variants → correct for multiple comparisons.

`brain audit` re-reads every logged results file and reports: edited metrics, missing or changed result files,
conclusions that claim an improvement no comparison supports, runs "running" for more than 7 days, single-seed
completed runs, and runs started from uncommitted code.

Records live in `.agent-brain/experiments/EXP-NNNN.yaml` (meant to be committed). Datasets, weights and credentials
are never stored — only paths and hashes.

## Skills in practice

- **ml-experiment** — "run a label-smoothing ablation", "loss goes to NaN", "is this model better?": baseline first,
  one change at a time, ≥ 3 seeds, untouched test set, results through `brain exp`, report only what the comparison
  supports. Long GPU/cloud jobs need your approval (`run-expensive-compute`).
- **data-analysis** — profiling, leakage check (`python3 scripts/leakage_check.py train.csv test.csv --id … --target …`,
  standard library), effect sizes with confidence intervals, multiple-comparison correction, reproducible notebooks.
  Refuses p-hacking; sensitive data is never uploaded without approval.
- **literature-review** — arXiv and Semantic Scholar search, one note per paper in `.agent-brain/papers/`, comparison
  tables with a source for every number; every citation must have an arXiv ID or DOI that was actually retrieved.
  Needs network access (`paper.search`); without it, the result is labelled "not a complete search".
- **bioinformatics-pipeline** — format checks (`python3 scripts/check_formats.py` for FASTA/FASTQ/VCF, gzip ok),
  one reference build everywhere, tool and database versions recorded, QC before analysis, dry-run workflows,
  genomic/patient data treated as sensitive, research calls are not clinical findings.

## Limits

- The environment probe imports your libraries in a subprocess (read-only, bounded by a timeout).
- Partial hashes of very large files detect most but not all changes.
- The t-test assumes roughly normal metric values across seeds; with 3–5 seeds it only detects large effects.
- Domain skills are `draft`: they guide the agent; they have not yet been evaluated live (see evaluation-guide.md).
