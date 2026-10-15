// Research / ML / bioinformatics project awareness for `brain init`.
//
// Reads notebook *code cells and metadata only* (never outputs, which can contain data or credentials), dependency
// manifests, and file names/sizes. Never reads dataset contents, never executes notebooks or code.
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './secrets.js';
import { truncate } from './util.js';

const MAX_NOTEBOOKS = 25;
const MAX_NOTEBOOK_BYTES = 8 * 1024 * 1024;

export const DATA_EXT = {
  '.csv': 'table', '.tsv': 'table', '.parquet': 'table', '.feather': 'table', '.xlsx': 'table', '.jsonl': 'table',
  '.npy': 'array', '.npz': 'array', '.h5': 'array', '.hdf5': 'array', '.zarr': 'array', '.nc': 'array', '.fits': 'array',
  '.pt': 'model', '.pth': 'model', '.ckpt': 'model', '.safetensors': 'model', '.onnx': 'model', '.pkl': 'model', '.joblib': 'model',
  '.fa': 'sequence', '.fasta': 'sequence', '.fna': 'sequence', '.faa': 'sequence', '.fq': 'sequence', '.fastq': 'sequence', '.gz': 'compressed',
  '.bam': 'alignment', '.sam': 'alignment', '.cram': 'alignment', '.vcf': 'variants', '.bcf': 'variants', '.gff': 'annotation', '.gff3': 'annotation', '.gtf': 'annotation', '.bed': 'annotation', '.pdb': 'structure', '.cif': 'structure',
};

export const ML_LIBS = {
  torch: 'PyTorch', tensorflow: 'TensorFlow', keras: 'Keras', jax: 'JAX', flax: 'Flax', sklearn: 'scikit-learn', 'scikit-learn': 'scikit-learn', xgboost: 'XGBoost', lightgbm: 'LightGBM',
  transformers: 'Hugging Face Transformers', datasets: 'Hugging Face Datasets', lightning: 'Lightning', pytorch_lightning: 'Lightning', wandb: 'Weights & Biases', mlflow: 'MLflow', optuna: 'Optuna',
  pandas: 'pandas', numpy: 'NumPy', scipy: 'SciPy', statsmodels: 'statsmodels', polars: 'Polars', matplotlib: 'Matplotlib', seaborn: 'seaborn',
  Bio: 'Biopython', biopython: 'Biopython', pysam: 'pysam', scanpy: 'scanpy', anndata: 'AnnData', snakemake: 'Snakemake',
  astropy: 'Astropy', qiskit: 'Qiskit', cirq: 'Cirq', pennylane: 'PennyLane',
};

const SEED_RE = /\b(?:seed\s*\(|manual_seed\s*\(|set_seed\s*\(|random_state\s*=|PRNGKey\s*\(|seed_everything\s*\(|np\.random\.default_rng\s*\(\s*\d)/;
const ABS_PATH_RE = /["'](?:\/Users\/|\/home\/|\/mnt\/|[A-Za-z]:\\\\)[^"']+["']/;
const READ_RE = /\b(?:read_csv|read_parquet|read_table|read_excel|read_json|read_feather|load_dataset|np\.load|torch\.load|pd\.read_hdf|SeqIO\.parse|pysam\.\w+File|open)\s*\(\s*(?:[rfb]?)["']([^"']{1,200})["']/g;
const B = (alts) => new RegExp(`(?<![A-Za-z0-9])(?:${alts})(?![A-Za-z0-9])`, 'i'); // underscores/dots count as separators
const REF_GENOMES = [
  { id: 'GRCh38/hg38', re: B('GRCh38|hg38'), organism: 'human' },
  { id: 'GRCh37/hg19', re: B('GRCh37|hg19|b37'), organism: 'human' },
  { id: 'GRCm39/mm39', re: B('GRCm39|mm39'), organism: 'mouse' },
  { id: 'GRCm38/mm10', re: B('GRCm38|mm10'), organism: 'mouse' },
];

function cellSource(cell) {
  return Array.isArray(cell?.source) ? cell.source.join('') : String(cell?.source ?? '');
}

/** Analyse one notebook from its JSON. Returns null when it is not a readable notebook. */
export function analyseNotebook(text) {
  let nb;
  try {
    nb = JSON.parse(text);
  } catch {
    return null;
  }
  if (!nb || !Array.isArray(nb.cells)) return null;
  const code = nb.cells.filter((c) => c.cell_type === 'code');
  const imports = new Set();
  const reads = new Set();
  let seed = false;
  let absPaths = 0;
  for (const c of code) {
    const src = cellSource(c);
    for (const m of src.matchAll(/^\s*(?:import\s+([\w.]+)|from\s+([\w.]+)\s+import)/gm)) imports.add((m[1] ?? m[2]).split('.')[0]);
    for (const m of src.matchAll(READ_RE)) reads.add(m[1]);
    if (SEED_RE.test(src)) seed = true;
    if (ABS_PATH_RE.test(src)) absPaths++;
  }
  const counts = code.map((c) => c.execution_count).filter((n) => Number.isInteger(n));
  const executed = counts.length;
  let outOfOrder = false;
  for (let i = 1; i < counts.length; i++) if (counts[i] <= counts[i - 1]) outOfOrder = true;
  const gaps = executed > 0 && executed < code.length; // some cells never run
  const hasOutputs = code.some((c) => Array.isArray(c.outputs) && c.outputs.length > 0);
  const kernel = nb.metadata?.kernelspec?.name ?? nb.metadata?.language_info?.name ?? null;
  return { cells: nb.cells.length, codeCells: code.length, executed, outOfOrder, partiallyExecuted: gaps, hasOutputs, seed, absPaths, imports: [...imports].sort(), reads: [...reads].sort(), kernel };
}

function readSmall(file, max = 512 * 1024) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function human(bytes) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let b = bytes;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b < 10 && i ? b.toFixed(1) : Math.round(b)} ${u[i]}`;
}

/**
 * Scan research-specific signals. `files` is the bounded census list [{ rel, size }]; `add(key, category, claim, rel,
 * locator, extra)` records an observed fact with file evidence; `addRaw(fact)` records a fact with custom evidence.
 */
export function scanResearch(root, files, { add, addRaw, notes, date }) {
  const byExt = (exts) => files.filter((f) => exts.includes(path.extname(f.rel).toLowerCase()));

  // --- notebooks -------------------------------------------------------------------------------------------------
  const notebooks = byExt(['.ipynb']).filter((f) => !f.rel.includes('.ipynb_checkpoints/')).slice(0, MAX_NOTEBOOKS);
  const nbSummary = [];
  for (const f of notebooks) {
    if (f.size > MAX_NOTEBOOK_BYTES) {
      add(`notebook.${f.rel}`, 'notebook', `Notebook ${f.rel} is ${human(f.size)} (too large to analyse; outputs are probably embedded).`, f.rel);
      continue;
    }
    const a = analyseNotebook(fs.readFileSync(path.join(root, f.rel), 'utf8'));
    if (!a) continue;
    nbSummary.push({ rel: f.rel, ...a });
    const libs = a.imports.map((i) => ML_LIBS[i]).filter(Boolean);
    add(`notebook.${f.rel}`, 'notebook', `Notebook ${f.rel}: ${a.codeCells} code cell(s), ${a.executed} executed${a.kernel ? `, kernel ${a.kernel}` : ''}${libs.length ? `; uses ${[...new Set(libs)].join(', ')}` : ''}${a.reads.length ? `; reads ${truncate(a.reads.map(redactSecrets).join(', '), 160)}` : ''}.`, f.rel, 'code cells (outputs not read)');
    const risks = [];
    if (a.outOfOrder) risks.push('cells were executed out of order (saved results may not be reproducible top to bottom)');
    if (a.partiallyExecuted) risks.push('some code cells were never executed');
    if (!a.seed && a.imports.some((i) => ['torch', 'tensorflow', 'jax', 'sklearn', 'numpy', 'random'].includes(i))) risks.push('no random seed is set');
    if (a.absPaths) risks.push(`${a.absPaths} cell(s) use machine-specific absolute paths`);
    if (risks.length) add(`notebook.risk.${f.rel}`, 'reproducibility', `Reproducibility risks in ${f.rel}: ${risks.join('; ')}.`, f.rel, 'execution_count / code cells');
  }
  if (notebooks.length) notes.types.add('notebooks');

  // --- ML / scientific libraries declared in Python environment files ----------------------------------------------
  const envFiles = ['requirements.txt', 'requirements-dev.txt', 'environment.yml', 'environment.yaml', 'pyproject.toml', 'setup.cfg', 'Pipfile'].filter((f) => fs.existsSync(path.join(root, f)));
  for (const ef of envFiles) {
    const text = readSmall(path.join(root, ef));
    if (!text) continue;
    const found = [];
    for (const [pkg, label] of Object.entries(ML_LIBS)) {
      const re = new RegExp(`(^|[\\s"'\\[,=-])${pkg.replace(/[-_]/g, '[-_]')}(?=[\\s"'<>=!~;,\\]\\[]|$)`, 'im');
      const m = text.match(new RegExp(`(^|[\\s"'\\[,=-])${pkg.replace(/[-_]/g, '[-_]')}\\s*(==|>=|~=|=)\\s*([\\w.*]+)`, 'im'));
      if (re.test(text)) found.push(m ? `${label} ${m[2] === '=' ? '' : m[2]}${m[3]}` : label);
    }
    const uniq = [...new Set(found)];
    if (uniq.length) add(`env.ml.${ef}`, 'stack', `${ef} declares research/ML libraries: ${uniq.join(', ')}.`, ef, 'dependency list (text match)');
    const cuda = text.match(/\b(cuda(?:toolkit)?|pytorch-cuda)\s*[=<>~!]*\s*([\d.]+)/i) ?? text.match(/\+cu(\d{3})/);
    if (cuda) add(`env.cuda.${ef}`, 'runtime', `${ef} pins a CUDA build (${cuda[0].trim()}).`, ef, 'CUDA pin');
    if (/^\s*-\s*bioconda\b|channels:[\s\S]{0,200}bioconda/m.test(text)) notes.types.add('bioinformatics');
    if (/^\s*-?\s*(qiskit|cirq|pennylane)\b/im.test(text)) notes.types.add('quantum');
  }

  // --- data, models, results directories (names and sizes only) --------------------------------------------------
  const dirs = new Map();
  for (const f of files) {
    const top = f.rel.split('/')[0];
    if (!/^(data|datasets|raw|processed|models|checkpoints|weights|outputs|results|runs|experiments|configs|notebooks|figures)$/i.test(top) || !f.rel.includes('/')) continue;
    const d = dirs.get(top) ?? { n: 0, size: 0 };
    d.n++;
    d.size += f.size;
    dirs.set(top, d);
  }
  for (const [d, v] of [...dirs.entries()].sort()) {
    addRaw({ key: `layout.${d}`, category: 'data', claim: `Directory ${d}/ holds ${v.n} file(s), ${human(v.size)} in total (contents not read).`, status: 'observed', evidence: [{ kind: 'command', command: `directory census of ${d}/ by brain init (names and sizes only)`, exit_code: 0, checked_at: date }] });
  }
  const dataFiles = files.filter((f) => DATA_EXT[path.extname(f.rel).toLowerCase()] && !f.rel.startsWith('.'));
  const kinds = {};
  for (const f of dataFiles) {
    const k = DATA_EXT[path.extname(f.rel).toLowerCase()];
    kinds[k] = kinds[k] ?? { n: 0, size: 0 };
    kinds[k].n++;
    kinds[k].size += f.size;
  }
  if (Object.keys(kinds).length) {
    addRaw({ key: 'data.census', category: 'data', claim: `Data/model files by kind: ${Object.entries(kinds).map(([k, v]) => `${k} ${v.n} (${human(v.size)})`).join(', ')}. Contents were not read.`, status: 'observed', evidence: [{ kind: 'command', command: 'file census by brain init (extensions and sizes only)', exit_code: 0, checked_at: date }] });
    if (kinds.sequence || kinds.alignment || kinds.variants) notes.types.add('bioinformatics');
    if (kinds.model) notes.types.add('ml');
    if (kinds.table || kinds.array) notes.types.add('data');
  }

  // --- data versioning ---------------------------------------------------------------------------------------------
  const dvc = files.filter((f) => f.rel.endsWith('.dvc') || /(^|\/)dvc\.(yaml|lock)$/.test(f.rel));
  if (dvc.length) add('data.versioning.dvc', 'data', `DVC tracks data or pipelines (${dvc.length} file(s), e.g. ${dvc[0].rel}).`, dvc[0].rel);
  const ga = readSmall(path.join(root, '.gitattributes'));
  if (ga && /filter=lfs/.test(ga)) add('data.versioning.lfs', 'data', `Git LFS is configured for: ${[...ga.matchAll(/^(\S+)\s+.*filter=lfs/gm)].map((m) => m[1]).slice(0, 8).join(', ')}.`, '.gitattributes', 'filter=lfs');
  if (!dvc.length && !(ga && /filter=lfs/.test(ga)) && dataFiles.length) notes.unknowns.push({ key: 'data.versioning', question: 'Data files are present but no data versioning (DVC, Git LFS, dataset hashes) was found; how are dataset versions tracked?' });

  // --- workflow managers and reference genomes -----------------------------------------------------------------------
  for (const [file, label] of [['Snakefile', 'Snakemake'], ['workflow/Snakefile', 'Snakemake'], ['main.nf', 'Nextflow'], ['nextflow.config', 'Nextflow']]) {
    if (fs.existsSync(path.join(root, file))) {
      add(`workflow.${label.toLowerCase()}`, 'pipeline', `${label} workflow defined in ${file}.`, file);
      notes.types.add('bioinformatics');
    }
  }
  const configLike = files.filter((f) => /\.(ya?ml|json|toml|cfg|config|nf|smk|ini)$/i.test(f.rel) || /(^|\/)Snakefile$/.test(f.rel)).slice(0, 300);
  const refHits = new Map();
  for (const f of configLike) {
    const text = readSmall(path.join(root, f.rel), 256 * 1024);
    if (!text) continue;
    for (const g of REF_GENOMES) if (g.re.test(text)) refHits.set(g.id, [...(refHits.get(g.id) ?? []), f.rel]);
  }
  const human_ = [...refHits.keys()].filter((id) => id.startsWith('GRCh'));
  const mouse = [...refHits.keys()].filter((id) => id.startsWith('GRCm'));
  for (const [id, where] of refHits) add(`genome.${id}`, 'reference-genome', `Reference genome ${id} is named in ${where.slice(0, 3).join(', ')}.`, where[0], 'text match');
  if (human_.length > 1 || mouse.length > 1) {
    const ids = [...(human_.length > 1 ? human_ : []), ...(mouse.length > 1 ? mouse : [])];
    addRaw({ key: 'genome.build', category: 'reference-genome', claim: `Configuration files name more than one build of the same genome (${ids.join(' and ')}); coordinates from different builds must not be mixed.`, status: 'disputed', evidence: ids.flatMap((id) => refHits.get(id).slice(0, 1).map((rel) => ({ rel, locator: id }))) });
  }

  // --- open questions for research projects ------------------------------------------------------------------------
  if (notebooks.length || dataFiles.length || dvc.length) {
    notes.unknowns.push({ key: 'research.question', question: 'What research question or hypothesis is this project testing, and what result would count as success?' });
    if (!files.some((f) => /^(experiments|runs|results)\//.test(f.rel)) && !fs.existsSync(path.join(root, '.agent-brain', 'experiments'))) notes.unknowns.push({ key: 'research.experiment-log', question: 'Where are experiment runs, configs and metrics recorded? (brain exp can record them with evidence.)' });
  }
  return { notebooks: nbSummary.length, dataFiles: dataFiles.length };
}
