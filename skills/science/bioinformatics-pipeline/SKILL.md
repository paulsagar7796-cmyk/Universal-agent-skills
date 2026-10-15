---
name: bioinformatics-pipeline
description: Builds, runs and checks bioinformatics workflows - validates FASTA, FASTQ, SAM/BAM, VCF and GFF/GTF inputs, keeps one reference genome build and records tool and database versions, runs quality control before analysis, uses workflow managers (Snakemake, Nextflow) reproducibly, and treats genomic and patient data as sensitive. Use for sequencing data, alignment, variant calling, RNA-seq, genome annotation, Biopython or pipeline debugging.
license: Apache-2.0
metadata:
  version: "0.1.0"
  category: science
  maturity: draft
  risk: medium
---

# Bioinformatics pipeline

Most silent errors in genomics come from mismatched references, unchecked inputs and unrecorded tool versions.
Check these first; the biology comes after.

## Workflow

1. **Inventory inputs** without loading them into chat: file types, sizes, compression, sample sheet. Validate format
   and basic integrity with `python3 scripts/check_formats.py <files…>` (standard library; reads the first records
   only; reports malformed records, sequence/quality length mismatches, VCF reference headers).
2. **Reference genome**: identify the build (GRCh38/hg38 vs GRCh37/hg19, GRCm39 vs GRCm38 …) for the reference
   FASTA, annotation (GTF/GFF), indexes, known-sites VCFs and any coordinates in configs. **All must match.** Chromosome
   naming (`chr1` vs `1`) must also match. `brain init` flags configs that mention more than one build.
3. **Record versions**: every tool (BWA, STAR, samtools, GATK, bcftools, …), database releases (Ensembl, GENCODE,
   dbSNP), container/conda environment; prefer pinned environments (conda `environment.yml`, containers) and record
   them in the brain (`brain remember … --evidence file:environment.yml`).
4. **Quality control before analysis**: read QC (FastQC/MultiQC), adapter and quality trimming, alignment rates,
   duplication, coverage, sex/sample identity checks where relevant. Stop and report if QC fails rather than
   continuing.
5. **Workflow manager**: express steps in Snakemake/Nextflow with explicit inputs/outputs; dry-run first
   (`snakemake -n`, `nextflow run … -preview` where supported); keep intermediate files out of git.
6. **Record runs** as experiments when they produce metrics (`brain exp start --config config.yaml --data …`).
7. **Interpretation**: state the reference, filters and thresholds used; variant or expression calls are evidence,
   not diagnoses.

See [references/formats-and-pitfalls.md](references/formats-and-pitfalls.md) for format details and common pitfalls.

## Sensitive data

Human genomic and clinical data can identify people and is often legally protected. Never upload it to external
services, paste sequences or sample identifiers into chat, or store them in the brain, without the user's explicit
approval (`upload-sensitive-data`) and confirmation that it is permitted. Large reference/database downloads need
approval first (`download-large-data`).

## Never

- Mix reference builds or annotation releases; silently liftover; drop failed samples without reporting them.
- Present research-grade variant calls as clinical findings.
- Run long or expensive jobs (cluster, cloud) without approval (`run-expensive-compute`).
