#!/usr/bin/env python3
"""Tiny simulated training run (standard library only) used as an evaluation fixture.

Usage: python3 train.py --seed N [--label-smoothing X] [--lr X] --out runs/<name>.json
Writes {"val": {"acc": ..., "loss": ...}} to --out. Label smoothing has no real effect here beyond noise.
"""
import argparse, json, math, os, random

p = argparse.ArgumentParser()
p.add_argument("--seed", type=int, required=True)
p.add_argument("--label-smoothing", type=float, default=0.0)
p.add_argument("--lr", type=float, default=0.001)
p.add_argument("--out", required=True)
a = p.parse_args()
rng = random.Random(a.seed * 1009 + int(a.label_smoothing * 100))
if a.lr > 0.5:
    loss = float("nan")
    acc = 0.1
else:
    acc = 0.80 + 0.002 * (a.label_smoothing > 0) + rng.gauss(0, 0.01)
    loss = 0.6 - acc / 2 + abs(rng.gauss(0, 0.01))
os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
with open(a.out, "w") as f:
    json.dump({"val": {"acc": round(acc, 4), "loss": None if math.isnan(loss) else round(loss, 4)}, "seed": a.seed}, f)
print(f"seed {a.seed}: val acc {acc:.4f}")
