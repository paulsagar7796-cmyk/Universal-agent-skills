// Strict YAML-subset parser and serializer (zero dependencies).
//
// Supported: block mappings and sequences, compact "- key: value" items, plain / single-quoted / double-quoted
// scalars (multi-line folding), flow sequences and mappings, literal (|) and folded (>) block scalars with
// chomping indicators, comments, YAML 1.2 core-schema booleans/null/numbers.
// Rejected with an error (never silently misparsed): anchors, aliases, tags, directives, multiple documents,
// complex keys, tabs in indentation, duplicate keys, plain scalars containing ": " or starting with reserved indicators.

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `YAML line ${line}: ${message}` : `YAML: ${message}`);
    this.name = 'YamlError';
    this.line = line;
  }
}

const RESERVED_START = new Set(['?', ':', ',', ']', '}', '#', '&', '*', '!', '|', '>', '%', '@', '`']);

function isBlank(line) {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

function indentOf(line) {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}

/** Strip a trailing " # comment" from a plain fragment (no quotes involved). */
function stripComment(s) {
  if (s.startsWith('#')) return '';
  const idx = s.search(/\s#/);
  return idx === -1 ? s : s.slice(0, idx);
}

function resolvePlain(raw, lineNo) {
  const s = raw.trim();
  if (s === '' || s === '~' || /^(null|Null|NULL)$/.test(s)) return null;
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?[0-9]+$/.test(s)) return Number.parseInt(s, 10);
  if (/^0x[0-9a-fA-F]+$/.test(s)) return Number.parseInt(s.slice(2), 16);
  if (/^0o[0-7]+$/.test(s)) return Number.parseInt(s.slice(2), 8);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(s)) return Number.parseFloat(s);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(s)) return Number.NaN;
  if (RESERVED_START.has(s[0])) throw new YamlError(`plain scalar cannot start with "${s[0]}"; quote the value`, lineNo);
  if (s.startsWith('- ') || s === '-') throw new YamlError('unexpected sequence entry; quote the value', lineNo);
  if (/:\s/.test(s) || s.endsWith(':')) throw new YamlError('plain scalar contains ": "; quote the value', lineNo);
  return s;
}

function unescapeDouble(body, lineNo) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = body[++i];
    const simple = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0', b: '\b', f: '\f', e: '\x1b', ' ': ' ', N: '\u0085', _: ' ', L: ' ', P: ' ', a: '\x07', v: '\v' };
    if (n in simple) out += simple[n];
    else if (n === 'x' || n === 'u' || n === 'U') {
      const len = n === 'x' ? 2 : n === 'u' ? 4 : 8;
      const hex = body.slice(i + 1, i + 1 + len);
      if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) throw new YamlError(`bad \\${n} escape`, lineNo);
      out += String.fromCodePoint(Number.parseInt(hex, 16));
      i += len;
    } else throw new YamlError(`unsupported escape \\${n}`, lineNo);
  }
  return out;
}

/** Find the closing quote of a quoted scalar starting at s[0]. Returns index or -1. */
function findClosingQuote(s) {
  const q = s[0];
  for (let i = 1; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === q) {
      if (q === "'" && s[i + 1] === "'") {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

function decodeQuoted(raw, lineNo) {
  const q = raw[0];
  const body = raw.slice(1, -1);
  return q === '"' ? unescapeDouble(body, lineNo) : body.replace(/''/g, "'");
}

/** Fold the line breaks of a multi-line quoted or plain scalar (YAML flow folding). */
function foldLines(parts) {
  let out = '';
  let pendingBreaks = 0;
  parts.forEach((p, idx) => {
    if (idx === 0) {
      out = p;
      return;
    }
    if (p === '') {
      pendingBreaks++;
      return;
    }
    out += pendingBreaks > 0 ? '\n'.repeat(pendingBreaks) : ' ';
    out += p;
    pendingBreaks = 0;
  });
  return out;
}

class FlowParser {
  constructor(text, lineNo) {
    this.s = text;
    this.i = 0;
    this.lineNo = lineNo;
  }
  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }
  value() {
    this.ws();
    const c = this.s[this.i];
    if (c === '[') return this.seq();
    if (c === '{') return this.map();
    if (c === '"' || c === "'") {
      const rest = this.s.slice(this.i);
      const end = findClosingQuote(rest);
      if (end === -1) throw new YamlError('unterminated quoted scalar in flow collection', this.lineNo);
      this.i += end + 1;
      return decodeQuoted(rest.slice(0, end + 1), this.lineNo);
    }
    let start = this.i;
    while (this.i < this.s.length && !',[]{}'.includes(this.s[this.i])) {
      if (this.s[this.i] === ':' && /\s/.test(this.s[this.i + 1] ?? ' ')) break;
      this.i++;
    }
    const raw = this.s.slice(start, this.i).trim();
    if (raw.includes(' #')) throw new YamlError('comments inside flow collections are not supported', this.lineNo);
    return resolvePlain(raw, this.lineNo);
  }
  seq() {
    this.i++;
    const out = [];
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      return out;
    }
    for (;;) {
      out.push(this.value());
      this.ws();
      const c = this.s[this.i++];
      if (c === ']') return out;
      if (c !== ',') throw new YamlError('expected "," or "]" in flow sequence', this.lineNo);
      this.ws();
      if (this.s[this.i] === ']') {
        this.i++;
        return out;
      }
    }
  }
  map() {
    this.i++;
    const out = {};
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      return out;
    }
    for (;;) {
      const key = this.value();
      if (typeof key === 'object' && key !== null) throw new YamlError('complex keys are not supported', this.lineNo);
      this.ws();
      if (this.s[this.i] !== ':') throw new YamlError('expected ":" in flow mapping', this.lineNo);
      this.i++;
      const k = String(key);
      if (Object.hasOwn(out, k)) throw new YamlError(`duplicate key "${k}"`, this.lineNo);
      out[k] = this.value();
      this.ws();
      const c = this.s[this.i++];
      if (c === '}') return out;
      if (c !== ',') throw new YamlError('expected "," or "}" in flow mapping', this.lineNo);
    }
  }
  parseAll() {
    const v = this.value();
    this.ws();
    const rest = this.s.slice(this.i);
    if (rest !== '' && !rest.startsWith('#')) throw new YamlError(`unexpected content after flow collection: "${rest}"`, this.lineNo);
    return v;
  }
}

function bracketDepth(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:]/.test(s[i - 1]))) {
      const end = findClosingQuote(s.slice(i));
      if (end === -1) return Number.POSITIVE_INFINITY;
      i += end;
    } else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth;
}

class Parser {
  constructor(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    this.lines = text.replace(/\r\n?/g, '\n').split('\n');
    this.i = 0;
    this.lines.forEach((line, idx) => {
      const lead = line.match(/^[ \t]*/)[0];
      if (lead.includes('\t') && line.trim() !== '') throw new YamlError('tabs are not allowed in indentation', idx + 1);
      const t = line.trim();
      if (t === '---' && idx !== 0) throw new YamlError('multiple documents are not supported', idx + 1);
      if (t === '...' || (t.startsWith('%') && indentOf(line) === 0)) throw new YamlError('directives/document markers are not supported', idx + 1);
    });
    if (this.lines[0]?.trim() === '---') this.i = 1;
  }

  skipBlank() {
    while (this.i < this.lines.length && isBlank(this.lines[this.i])) this.i++;
  }

  parseDocument() {
    this.skipBlank();
    if (this.i >= this.lines.length) return null;
    const ind = indentOf(this.lines[this.i]);
    const value = this.parseNode(ind);
    this.skipBlank();
    if (this.i < this.lines.length) throw new YamlError('unexpected content (check indentation)', this.i + 1);
    return value;
  }

  parseNode(ind) {
    this.skipBlank();
    if (this.i >= this.lines.length) return null;
    const line = this.lines[this.i];
    const content = line.slice(ind);
    if (content === '-' || content.startsWith('- ')) return this.parseSeq(ind);
    if (splitKey(content, this.i + 1)) return this.parseMap(ind);
    const lineNo = this.i + 1;
    this.i++;
    return this.parseInlineValue(content, ind - 1, lineNo);
  }

  /** Value of a key whose inline part is empty: nested block, compact sequence, or null. */
  parseNested(parentIndent) {
    this.skipBlank();
    if (this.i >= this.lines.length) return null;
    const line = this.lines[this.i];
    const ind = indentOf(line);
    if (ind > parentIndent) return this.parseNode(ind);
    const content = line.slice(ind);
    if (ind === parentIndent && (content === '-' || content.startsWith('- '))) return this.parseSeq(ind);
    return null;
  }

  parseMap(ind) {
    const out = {};
    for (;;) {
      this.skipBlank();
      if (this.i >= this.lines.length) break;
      const line = this.lines[this.i];
      const cur = indentOf(line);
      if (cur < ind) break;
      if (cur > ind) throw new YamlError('unexpected indentation', this.i + 1);
      const content = line.slice(ind);
      if (content === '-' || content.startsWith('- ')) break;
      const lineNo = this.i + 1;
      const kv = splitKey(content, lineNo);
      if (!kv) throw new YamlError('expected "key: value"', lineNo);
      if (Object.hasOwn(out, kv.key)) throw new YamlError(`duplicate key "${kv.key}"`, lineNo);
      this.i++;
      out[kv.key] = kv.rest === '' ? this.parseNested(ind) : this.parseInlineValue(kv.rest, ind, lineNo);
    }
    return out;
  }

  parseSeq(ind) {
    const out = [];
    for (;;) {
      this.skipBlank();
      if (this.i >= this.lines.length) break;
      const line = this.lines[this.i];
      const cur = indentOf(line);
      if (cur < ind) break;
      if (cur > ind) throw new YamlError('unexpected indentation in sequence', this.i + 1);
      const content = line.slice(ind);
      if (!(content === '-' || content.startsWith('- '))) break;
      const lineNo = this.i + 1;
      const afterDash = content.slice(1);
      const rest = afterDash.trimStart();
      const itemIndent = ind + 1 + (afterDash.length - rest.length);
      if (stripComment(rest).trim() === '') {
        this.i++;
        const nextIdx = this.i;
        this.skipBlank();
        const next = this.lines[this.i];
        this.i = nextIdx;
        out.push(next !== undefined && indentOf(next) > ind ? this.parseNested(ind) : null);
        continue;
      }
      if (rest.startsWith('- ') || rest === '-') throw new YamlError('nested inline sequences ("- - x") are not supported', lineNo);
      if (splitKey(rest, lineNo)) {
        this.lines[this.i] = ' '.repeat(itemIndent) + rest;
        out.push(this.parseMap(itemIndent));
        continue;
      }
      this.i++;
      out.push(this.parseInlineValue(rest, ind, lineNo));
    }
    return out;
  }

  /** Parse a value that begins on the current (already consumed) line. parentIndent = indent of the owning key/dash. */
  parseInlineValue(rest, parentIndent, lineNo) {
    const r = rest.trimStart();
    const c = r[0];
    if (c === '&' || c === '*') throw new YamlError('anchors and aliases are not supported', lineNo);
    if (c === '!') throw new YamlError('tags are not supported', lineNo);
    if (c === '|' || c === '>') return this.parseBlockScalar(r, parentIndent, lineNo);
    if (c === '"' || c === "'") return this.parseQuoted(r, lineNo);
    if (c === '[' || c === '{') {
      let text = r;
      while (bracketDepth(text) > 0) {
        if (this.i >= this.lines.length) throw new YamlError('unterminated flow collection', lineNo);
        text += ' ' + this.lines[this.i++].trim();
      }
      return new FlowParser(text, lineNo).parseAll();
    }
    const first = stripComment(r).trim();
    const parts = [first];
    if (!r.includes(' #')) {
      // multi-line plain scalar: continuation lines indented deeper than the parent
      while (this.i < this.lines.length) {
        const l = this.lines[this.i];
        if (l.trim() === '') {
          let j = this.i;
          while (j < this.lines.length && this.lines[j].trim() === '') j++;
          if (j < this.lines.length && indentOf(this.lines[j]) > parentIndent && !this.lines[j].trim().startsWith('#')) {
            for (let k = this.i; k < j; k++) parts.push('');
            this.i = j;
            continue;
          }
          break;
        }
        if (indentOf(l) <= parentIndent || l.trim().startsWith('#')) break;
        const t = l.trim();
        if (splitKey(t, this.i + 1) && parts.length === 1 && first === '') break;
        parts.push(stripComment(t).trim());
        const ended = t.includes(' #');
        this.i++;
        if (ended) break;
      }
    }
    if (parts.length === 1) return resolvePlain(first, lineNo);
    const folded = foldLines(parts);
    if (/:\s/.test(folded)) throw new YamlError('plain scalar contains ": "; quote the value', lineNo);
    return folded;
  }

  parseQuoted(r, lineNo) {
    let text = r;
    let end = findClosingQuote(text);
    const parts = [];
    if (end === -1) {
      parts.push(text.trimEnd());
      while (end === -1) {
        if (this.i >= this.lines.length) throw new YamlError('unterminated quoted scalar', lineNo);
        const t = this.lines[this.i++].trim();
        parts.push(t);
        end = findClosingQuote(parts.join('\n'));
      }
      text = parts.join('\n');
    }
    const after = text.slice(end + 1).trim();
    if (after !== '' && !after.startsWith('#')) throw new YamlError('unexpected content after quoted scalar', lineNo);
    const raw = text.slice(0, end + 1);
    if (parts.length === 0) return decodeQuoted(raw, lineNo);
    // multi-line quoted: fold line breaks, then decode escapes
    const q = raw[0];
    const lines = raw.slice(1, -1).split('\n').map((l, idx) => (idx === 0 ? l.trimEnd() : l.trim()));
    const folded = foldLines(lines);
    return q === '"' ? unescapeDouble(folded, lineNo) : folded.replace(/''/g, "'");
  }

  parseBlockScalar(header, parentIndent, lineNo) {
    const m = header.match(/^([|>])([+-]?)\s*(#.*)?$/);
    if (!m) throw new YamlError(`unsupported block scalar header "${header}"`, lineNo);
    const [, style, chomp] = m;
    const raw = [];
    let contentIndent = -1;
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (l.trim() === '') {
        raw.push('');
        this.i++;
        continue;
      }
      const ind = indentOf(l);
      if (contentIndent === -1) {
        if (ind <= parentIndent) break;
        contentIndent = ind;
      }
      if (ind < contentIndent) break;
      raw.push(l.slice(contentIndent));
      this.i++;
    }
    // give trailing blank lines back if they are followed by less-indented content (they belong to chomping only)
    let trailing = 0;
    while (raw.length && raw[raw.length - 1] === '') {
      raw.pop();
      trailing++;
    }
    let body;
    if (style === '|') body = raw.join('\n');
    else {
      body = '';
      raw.forEach((l, idx) => {
        const prev = raw[idx - 1];
        if (idx === 0) body = l;
        else if (l === '') body += '\n';
        else if (prev === '') body += l;
        else if (l.startsWith(' ') || prev.startsWith(' ')) body += '\n' + l;
        else body += ' ' + l;
      });
    }
    if (raw.length === 0) return '';
    if (chomp === '-') return body;
    if (chomp === '+') return body + '\n'.repeat(trailing + 1);
    return body + '\n';
  }
}

/** Split "key: rest" or "key:" into {key, rest}; returns null if the line is not a mapping entry. */
function splitKey(content, lineNo) {
  const c = content[0];
  if (c === undefined || c === '#' || c === '[' || c === '{' || c === '|' || c === '>') return null;
  if (c === '?') throw new YamlError('complex keys are not supported', lineNo);
  if (c === '"' || c === "'") {
    const end = findClosingQuote(content);
    if (end === -1) return null;
    const after = content.slice(end + 1);
    if (!/^\s*:(\s|$)/.test(after)) return null;
    const key = decodeQuoted(content.slice(0, end + 1), lineNo);
    return { key, rest: after.replace(/^\s*:/, '').trim() };
  }
  if (c === '&' || c === '*' || c === '!') {
    if (/^[&*!]\S*\s*:(\s|$)/.test(content) || /^[&*!]/.test(content)) throw new YamlError('anchors, aliases and tags are not supported', lineNo);
  }
  const m = content.match(/^([^#]*?)\s*:(\s|$)/);
  if (!m) return null;
  const key = m[1];
  if (key === '' || key.includes(' #')) return null;
  if (/^-(\s|$)/.test(key)) return null;
  const rest = content.slice(m[0].length).trim();
  return { key: key.trimEnd(), rest };
}

export function parse(text) {
  return new Parser(String(text)).parseDocument();
}

/** Extract YAML frontmatter from a Markdown document. */
export function parseFrontmatter(text) {
  const src = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!src.startsWith('---\n')) return { data: null, body: src, error: 'missing YAML frontmatter (file must start with ---)' };
  const end = src.indexOf('\n---', 3);
  if (end === -1) return { data: null, body: src, error: 'unterminated YAML frontmatter (no closing ---)' };
  const after = src.slice(end + 4);
  if (after !== '' && !after.startsWith('\n')) return { data: null, body: src, error: 'closing --- must be on its own line' };
  const yamlText = src.slice(4, end);
  try {
    const data = parse(yamlText);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return { data: null, body: after.slice(1), error: 'frontmatter must be a mapping' };
    const bodyStartLine = yamlText.split('\n').length + 2;
    return { data, body: after.replace(/^\n/, ''), error: null, bodyStartLine };
  } catch (e) {
    return { data: null, body: after.replace(/^\n/, ''), error: e.message };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Serializer

const PLAIN_SAFE = /^[A-Za-z_/.][A-Za-z0-9 _./()+,;=@'-]*$/;

function needsQuote(s) {
  if (s === '' || s !== s.trim()) return true;
  if (!PLAIN_SAFE.test(s)) return true;
  if (/:\s|\s#|:$/.test(s)) return true;
  try {
    return resolvePlain(s) !== s;
  } catch {
    return true;
  }
}

function formatKey(k) {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k) && resolvePlain(k) === k ? k : JSON.stringify(k);
}

function formatScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return '.nan';
    if (!Number.isFinite(v)) return v > 0 ? '.inf' : '-.inf';
    return String(v);
  }
  if (typeof v === 'string') return needsQuote(v) ? JSON.stringify(v) : v;
  throw new YamlError(`cannot serialize value of type ${typeof v}`);
}

function isLiteralFriendly(s) {
  return s.includes('\n') && !s.endsWith('\n') && !s.includes('\r') && !/^\s/.test(s) && !/[^\S\n]$/m.test(s) && !/[\x00-\x08\x0b-\x1f\x7f]/.test(s);
}

function emit(value, indent, out) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === 'object' && (Array.isArray(item) ? item.length : Object.keys(item).length)) {
        const sub = [];
        emit(item, indent + 2, sub);
        if (Array.isArray(item)) {
          out.push(`${pad}-`);
          out.push(...sub);
        } else {
          sub[0] = `${pad}- ${sub[0].slice(indent + 2)}`;
          out.push(...sub);
        }
      } else if (typeof item === 'string' && isLiteralFriendly(item)) {
        out.push(`${pad}- |-`);
        for (const l of item.split('\n')) out.push(l === '' ? '' : `${pad}  ${l}`);
      } else {
        out.push(`${pad}- ${emptyOrScalar(item)}`);
      }
    }
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const key = formatKey(k);
    if (v !== null && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length)) {
      out.push(`${pad}${key}:`);
      emit(v, indent + 2, out);
    } else if (typeof v === 'string' && isLiteralFriendly(v)) {
      out.push(`${pad}${key}: |-`);
      for (const l of v.split('\n')) out.push(l === '' ? '' : `${pad}  ${l}`);
    } else {
      out.push(`${pad}${key}: ${emptyOrScalar(v)}`);
    }
  }
}

function emptyOrScalar(v) {
  if (Array.isArray(v)) return '[]';
  if (v !== null && typeof v === 'object') return '{}';
  return formatScalar(v);
}

/** Serialize a value to YAML text. `header` lines are emitted as comments. */
export function stringify(value, { header } = {}) {
  const out = [];
  if (header) for (const h of header.split('\n')) out.push(h === '' ? '#' : `# ${h}`);
  if (value === null || typeof value !== 'object') out.push(formatScalar(value));
  else if (Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0) out.push(Array.isArray(value) ? '[]' : '{}');
  else emit(value, 0, out);
  return out.join('\n') + '\n';
}
