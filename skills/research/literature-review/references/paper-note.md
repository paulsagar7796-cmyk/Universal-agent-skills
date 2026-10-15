# Paper note template

Save as `.agent-brain/papers/<identifier>.md` (replace `/` with `_` in DOIs). Fill only what you read; write
"not reported" or "not checked" rather than guessing.

```markdown
---
id: arXiv:2401.12345v2            # or doi:10.1038/s41586-024-00000-0
title: <exact title>
authors: [<as listed>]
year: 2024
venue: <journal/conference, or "preprint">
url: https://arxiv.org/abs/2401.12345v2
accessed: "YYYY-MM-DD"
read: abstract | full-text
code: <URL or "not released">
data: <datasets used>
---

## Claim
One or two sentences: what the paper says it shows.

## Method
## Evaluation setup
Datasets, splits, metrics, baselines, number of runs/seeds.

## Results
Key numbers with their conditions (dataset, metric, split). Quote table/figure numbers.

## Limitations
Stated by the authors, and ones you noticed (small sample, single seed, no ablation, leakage risk …).

## Relevance to this project
```

Identifier formats: arXiv new style `YYMM.NNNNN` with optional `vN` (e.g. `2401.12345v2`), old style
`category/YYMMNNN` (e.g. `hep-ex/0307015`); DOIs start with `10.` followed by a registrant code and a suffix.
