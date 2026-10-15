# Experiments

One file per run: `EXP-NNNN.yaml`, written by `brain exp`. Each record captures the question, baseline, git commit,
config and data fingerprints, split, seeds, environment, and metrics **read from the results files the run produced**
(path and hash kept as evidence). Comparisons (`brain exp compare`) use Welch's t-test over seeds and refuse to call a
difference an improvement with fewer than 3 seeds or when data/splits differ.

Do not edit metrics by hand: `brain audit` re-reads the results files and reports mismatches.
