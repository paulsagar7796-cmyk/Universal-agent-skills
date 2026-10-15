#!/usr/bin/env python3
"""Quick integrity checks for FASTA, FASTQ and VCF files (plain or gzip). Standard library only; reads local files;
sends nothing anywhere; reads at most --max-records records per file.

Usage: python3 check_formats.py FILE [FILE ...] [--max-records N] [--json]
Exit code 1 when a file has errors, 0 otherwise, 2 on usage errors.
"""
import argparse
import gzip
import json
import os
import re
import sys

DNA = set("ACGTUNRYKMSWBDHVacgtunrykmswbdhv-.*")
BUILDS = re.compile(r"(?<![A-Za-z0-9])(GRCh38|hg38|GRCh37|hg19|b37|GRCm39|mm39|GRCm38|mm10)(?![A-Za-z0-9])", re.I)


def opener(path):
    with open(path, "rb") as f:
        magic = f.read(2)
    return gzip.open(path, "rt", encoding="utf-8", errors="replace") if magic == b"\x1f\x8b" else open(path, encoding="utf-8", errors="replace")


def kind(path):
    name = path.lower()
    for suffix in (".gz", ".bgz"):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
    if name.endswith((".fastq", ".fq")):
        return "fastq"
    if name.endswith((".fasta", ".fa", ".fna", ".faa", ".fas")):
        return "fasta"
    if name.endswith(".vcf"):
        return "vcf"
    return None


def check_fastq(f, max_records):
    errors, n, ids = [], 0, set()
    while n < max_records:
        head = f.readline()
        if not head:
            break
        seq, plus, qual = f.readline().rstrip("\n"), f.readline(), f.readline().rstrip("\n")
        n += 1
        if not head.startswith("@"):
            errors.append(f"record {n}: header does not start with '@'")
            break
        if not plus.startswith("+"):
            errors.append(f"record {n}: third line does not start with '+'")
            break
        if len(seq) != len(qual):
            errors.append(f"record {n}: sequence length {len(seq)} != quality length {len(qual)}")
        if set(seq) - DNA:
            errors.append(f"record {n}: unexpected characters in sequence")
        rid = head[1:].split()[0] if head[1:].split() else ""
        if rid in ids:
            errors.append(f"record {n}: duplicate read id {rid}")
        ids.add(rid)
        if len(errors) >= 20:
            break
    return {"records_checked": n, "errors": errors}


def check_fasta(f, max_records):
    errors, n, names, seq_len, protein = [], 0, set(), None, False
    for line in f:
        line = line.rstrip("\n")
        if line.startswith(">"):
            if seq_len == 0:
                errors.append(f"record {n}: empty sequence")
            n += 1
            if n > max_records:
                n -= 1
                break
            name = line[1:].split()[0] if line[1:].split() else ""
            if name in names:
                errors.append(f"record {n}: duplicate header {name}")
            names.add(name)
            seq_len = 0
        elif line.strip():
            if n == 0:
                errors.append("sequence data before the first '>' header")
                break
            seq_len = (seq_len or 0) + len(line)
            if set(line) - DNA:
                protein = True
    return {"records_checked": n, "errors": errors, "alphabet": "protein-or-other" if protein else "nucleotide"}


def check_vcf(f, max_records):
    errors, meta, n, header_seen, builds = [], {}, 0, False, set()
    for line in f:
        line = line.rstrip("\n")
        if line.startswith("##"):
            key = line[2:].split("=", 1)[0]
            meta[key] = meta.get(key, 0) + 1
            builds.update(m.group(1) for m in BUILDS.finditer(line))
        elif line.startswith("#CHROM"):
            header_seen = True
            cols = line[1:].split("\t")
            if cols[:8] != ["CHROM", "POS", "ID", "REF", "ALT", "QUAL", "FILTER", "INFO"]:
                errors.append("#CHROM header does not have the 8 standard columns")
        elif line.strip():
            n += 1
            if not header_seen:
                errors.append("records before the #CHROM header")
                break
            fields = line.split("\t")
            if len(fields) < 8:
                errors.append(f"record {n}: fewer than 8 columns")
            elif not fields[1].isdigit():
                errors.append(f"record {n}: POS is not an integer")
            if n >= max_records or len(errors) >= 20:
                break
    if "fileformat" not in meta:
        errors.append("missing ##fileformat header")
    out = {"records_checked": n, "errors": errors, "reference_builds_in_header": sorted(builds)}
    if "reference" not in meta:
        out["warning"] = "no ##reference header: the genome build cannot be confirmed from this file"
    if len({b.lower() for b in builds}) > 1:
        errors.append(f"header mentions more than one build: {', '.join(sorted(builds))}")
    return out


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("files", nargs="+")
    p.add_argument("--max-records", type=int, default=10000)
    p.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    report, bad = {}, False
    for path in a.files:
        k = kind(path)
        if not os.path.isfile(path):
            report[path] = {"errors": ["file not found"]}
            bad = True
            continue
        if not k:
            report[path] = {"skipped": "unsupported extension (FASTA, FASTQ, VCF; optionally .gz)"}
            continue
        with opener(path) as f:
            r = {"fastq": check_fastq, "fasta": check_fasta, "vcf": check_vcf}[k](f, a.max_records)
        r["format"] = k
        report[path] = r
        bad = bad or bool(r["errors"])
    if a.json:
        print(json.dumps(report, indent=2))
    else:
        for path, r in report.items():
            status = "SKIPPED" if "skipped" in r else ("ERRORS" if r.get("errors") else "OK")
            print(f"{path}: {status} ({r.get('format', '?')}, {r.get('records_checked', 0)} record(s) checked)")
            for e in r.get("errors", []):
                print(f"  - {e}")
            if r.get("warning"):
                print(f"  ! {r['warning']}")
            if r.get("reference_builds_in_header"):
                print(f"  reference build(s) named in header: {', '.join(r['reference_builds_in_header'])}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
