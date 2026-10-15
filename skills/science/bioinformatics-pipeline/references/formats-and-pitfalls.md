# Formats and common pitfalls

| Format | Structure | Quick checks |
|---|---|---|
| FASTA | `>header` line, then sequence lines | Headers unique; only expected alphabet (ACGTN… for DNA, amino acids for protein); no empty sequences |
| FASTQ | 4 lines per read: `@id`, sequence, `+`, quality | Sequence and quality lengths equal; quality encoding (Phred+33 today; Phred+64 in old Illumina data); paired files have matching read ids and counts |
| SAM/BAM/CRAM | Header (`@SQ` contig names and lengths) + alignments | Contig names/lengths match the reference FASTA; sorted and indexed; CRAM needs the exact reference used |
| VCF | `##fileformat`, `##reference`, `##contig`, `#CHROM` header, records | Reference/contig headers match the build; REF alleles match the reference sequence; multi-allelic and normalisation consistent |
| GFF3/GTF | 9 tab-separated columns | Same build and naming as the reference; release version recorded (e.g. GENCODE v44) |
| BED | 0-based, half-open | Off-by-one when converting from 1-based formats (VCF, GFF) |

## Pitfalls

- **Build mismatch** (hg19 vs hg38): wrong coordinates without any error. Check every input's header and source.
- **Chromosome naming**: `chr1` vs `1`, `chrM` vs `MT` — tools may silently drop non-matching records.
- **Coordinate systems**: BED is 0-based half-open; VCF/GFF are 1-based inclusive.
- **Paired-end order**: R1/R2 files must stay in the same read order; trimming must keep pairs together.
- **Sample swaps**: check sex/genotype concordance against metadata.
- **Index/version drift**: an aligner index built with one tool version or reference may not match another.
- **Compressed files**: `.gz` vs BGZF (`.bgz`): many tools need BGZF + index for random access.
