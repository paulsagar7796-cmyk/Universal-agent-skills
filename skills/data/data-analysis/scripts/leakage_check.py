#!/usr/bin/env python3
"""Leakage check for train/test CSV or TSV files. Standard library only; reads local files; sends nothing anywhere.

Usage: python3 leakage_check.py TRAIN TEST [--id COLUMN] [--target COLUMN] [--max-rows N] [--json]

Reports:
  - exact duplicate rows between the files (ignoring the id column)
  - id values present in both files
  - features that equal (or almost always equal) the target in TRAIN (target leakage)
  - constant columns and missing-value rates
Exit code 1 when a likely leak is found, 0 otherwise, 2 on usage errors.
Signals only: a clean result does not prove the absence of leakage (e.g. future information or group leakage).
"""
import argparse
import csv
import json
import sys


def read(path, max_rows):
    delim = "\t" if path.endswith((".tsv", ".tab")) else ","
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter=delim)
        rows = []
        for i, row in enumerate(reader):
            if i >= max_rows:
                break
            rows.append(row)
        return reader.fieldnames or [], rows


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("train")
    p.add_argument("test")
    p.add_argument("--id", dest="id_col")
    p.add_argument("--target")
    p.add_argument("--max-rows", type=int, default=500000)
    p.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    try:
        cols_tr, tr = read(a.train, a.max_rows)
        cols_te, te = read(a.test, a.max_rows)
    except OSError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    for c in (a.id_col, a.target):
        if c and c not in cols_tr:
            print(f"error: column {c!r} not in {a.train} (columns: {', '.join(cols_tr)})", file=sys.stderr)
            return 2

    findings = []
    shared = [c for c in cols_tr if c in cols_te and c != a.id_col]
    key = lambda r: tuple(r.get(c, "") for c in shared)  # noqa: E731
    train_keys = {key(r) for r in tr}
    dup = sum(1 for r in te if key(r) in train_keys)
    if dup:
        findings.append({"severity": "high", "check": "duplicate-rows", "detail": f"{dup} of {len(te)} test rows also appear in train (all shared columns equal)"})
    if a.id_col and a.id_col in cols_te:
        overlap = {r[a.id_col] for r in tr} & {r[a.id_col] for r in te}
        if overlap:
            sample = ", ".join(sorted(overlap)[:5])
            findings.append({"severity": "high", "check": "id-overlap", "detail": f"{len(overlap)} id value(s) in both files (e.g. {sample})"})
    if a.target and tr:
        y = [r[a.target] for r in tr]
        for c in cols_tr:
            if c in (a.target, a.id_col):
                continue
            x = [r[c] for r in tr]
            same = sum(1 for xi, yi in zip(x, y) if xi == yi)
            mapping = {}
            consistent = 0
            for xi, yi in zip(x, y):
                mapping.setdefault(xi, {}).setdefault(yi, 0)
                mapping[xi][yi] += 1
            if len(mapping) < len(x):
                consistent = sum(max(v.values()) for v in mapping.values())
            if same / len(x) >= 0.98:
                findings.append({"severity": "high", "check": "target-copy", "detail": f"column {c!r} equals the target in {same}/{len(x)} train rows"})
            elif len(mapping) > 1 and len(mapping) < len(x) * 0.5 and consistent / len(x) >= 0.99:
                findings.append({"severity": "medium", "check": "target-proxy", "detail": f"column {c!r} determines the target in {consistent}/{len(x)} train rows ({len(mapping)} distinct values)"})
    profile = {}
    for c in cols_tr:
        vals = [r[c] for r in tr]
        missing = sum(1 for v in vals if v in ("", "NA", "NaN", "nan", "null", "None"))
        distinct = len(set(vals))
        profile[c] = {"missing_pct": round(100 * missing / max(1, len(vals)), 2), "distinct": distinct}
        if distinct == 1 and len(vals) > 1:
            findings.append({"severity": "low", "check": "constant-column", "detail": f"column {c!r} is constant in train"})
    report = {"train_rows": len(tr), "test_rows": len(te), "findings": findings, "profile": profile,
              "note": "Signals only. Also consider future information, preprocessing fitted on all data and group leakage."}
    if a.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"train rows {len(tr)}, test rows {len(te)}")
        for f in findings:
            print(f"[{f['severity']}] {f['check']}: {f['detail']}")
        if not findings:
            print("no leakage signals found (not proof of absence)")
        print(report["note"])
    return 1 if any(f["severity"] == "high" for f in findings) else 0


if __name__ == "__main__":
    sys.exit(main())
